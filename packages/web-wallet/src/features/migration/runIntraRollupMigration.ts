/**
 * The exit half of an intra-rollup migration, on the web wallet's own rails: publish a
 * self-resolved SIPA of the live deployment, then burn the balance on a historic l2Token to it
 * through the same `runBurn` as every withdrawal. From there the withdrawal tracker follows the
 * exit and the deposit rail claims the arrival, so nothing waits in this tab. Never signs L1.
 */
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  deploymentScanRange,
  deriveBootstrapKey,
  deriveStealthKey,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import {
  fetchSipaResolverOperators,
  IntraRollupMigrationService,
  predictAccountAddress,
  resolverSelectionPolicy,
  selectManifestResolverOperator,
  SipaSelfResolver,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
} from "@obsidion/sdk"
import { formatUnits, type Hex } from "viem"
import { DEFAULT_DECIMALS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { getConfig } from "../../config/env"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { claimSponsorContext } from "../onboarding/claimSponsorship"
import { RAIL_REGISTERED } from "../onboarding/rails"
import { getSipaDepositGateway } from "../deposit/sipaGateway"
import { runOperation, type OperationHandle } from "../operations/operations"
import { publishMigrationArrival } from "./migrationArrival"
import { currentDeployment, runBurn } from "../withdraw/withdrawGateway"
import { historicTokenContext } from "./historicTokenContext"
import { loadMigrationFee } from "./migrationFee"

interface MigrationParams {
  wallet: ObsidionWallet
  account: ObsidionAccount
  contractService: ContractService
  toTokenService: TokenService
  historic: OxideEnvTuple
  current: OxideEnvTuple
  /** The operation's one line: `migrationSummary` of the amount. */
  summary: string
}

/** How the exit row names where the funds go: the account's own balance on the live deployment. */
export const MIGRATION_RECIPIENT_ALIAS = "Your balance on the new version"

/**
 * One operation from the first step: the arrival's publish runs inside it as a child, then the
 * burn. Resolves with the burn's withdrawal record once it mines, or once it reached the node.
 */
export function runIntraRollupMigration(params: MigrationParams): Promise<WithdrawalRecord> {
  return runOperation(
    { operationId: `migration_${crypto.randomUUID()}`, flow: "migration", summary: params.summary },
    (op) => migrateFlow(params, op),
  )
}

async function migrateFlow(
  params: MigrationParams,
  op: OperationHandle,
): Promise<WithdrawalRecord> {
  const config = getConfig()
  const publicClient = l1PublicClient(config)
  const msk = await getAuthService().getSecretKey()
  if (!msk) throw new Error("wallet is locked")

  const records = await fetchSipaResolverOperators(
    publicClient,
    requireTupleField(params.current, "accountMetadataRegistry") as Hex,
    await deploymentScanRange(publicClient, params.current),
  )
  const resolver = selectManifestResolverOperator(records, {
    portal: requireTupleField(params.current, "portal"),
    resolverGatewayUrl: params.current.resolverGatewayUrl,
    ...resolverSelectionPolicy(config.network),
  })
  const selfResolver = new SipaSelfResolver(
    deriveStealthKey(msk).scalar,
    resolver.resolverPublicKey,
  )

  const { tokenService: fromTokenService } = await historicTokenContext(
    params.wallet,
    params.account,
    params.historic,
  )

  const migration = new IntraRollupMigrationService({
    node: params.wallet.node as never,
    fromTokenService,
    toTokenService: params.toTokenService,
    from: params.historic,
    selfResolver,
    recoveryAccount: await predictAccountAddress(
      publicClient,
      requireTupleField(params.current, "accountFactory") as Hex,
      deriveBootstrapKey(msk).address,
    ),
    to: {
      recoveryProtocol: params.current.sipaRecoveryProtocol ?? "legacy-eoa",
      portal: requireTupleField(params.current, "portal") as Hex,
      sipaFactory: requireTupleField(params.current, "sipaFactory") as Hex,
    },
    publicClient,
  })

  const [resolveSpendMetadata, resolveDepositSpendMetadata] = await Promise.all([
    params.account.makeSpendMetadataResolver(),
    params.account.makeDepositSpendMetadataResolver(),
  ])
  const [tokenSymbol, deployment, fee] = await Promise.all([
    params.toTokenService.fetchTokenInformation().then((t) => t.symbol),
    // The historic portal: the tracker polls its spent bit, not the live one's.
    currentDeployment(params.historic),
    // Only prices the rows; a failed read leaves them without a fee rather than a wrong one.
    loadMigrationFee(params.historic, params.current).catch(() => undefined),
  ])

  // Before any record exists: a refused or failed publish ends the move with nothing burned.
  const prepared = await migration.prepareExit({
    account: params.account,
    amount: await fromTokenService.getBalance(params.account),
    // Shares the receive flow's slot counter: a migration SIPA is one more self-resolution.
    nonceForDay: (day) => getSipaDepositGateway().nextSelfNonce(params.wallet, day),
    broadcastSipa: (sipa) => publishMigrationArrival(params, sipa, params.summary, op.operationId),
  })
  const { amount, resolved } = prepared

  const { record } = await runBurn({
    op,
    wallet: params.wallet,
    record: {
      intent: "migration",
      recipient: resolved.sipaAddress,
      recipientProvenance: "saved-recipient",
      recipientAlias: MIGRATION_RECIPIENT_ALIAS,
      amount: formatUnits(amount, DEFAULT_DECIMALS),
      rawAmount: amount.toString(),
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
      ...fee,
      tokenSymbol,
      phase: "submitting",
      startTime: Date.now(),
      deployment,
    },
    burn: async () => {
      const exit = await migration.burn(prepared, {
        account: params.account,
        operationId: op.operationId,
        // Selects the retired FPC whose policy pins the historic token. Built lazily — the
        // subscribe leg is per-FPC.
        sponsor: () =>
          claimSponsorContext(
            {
              wallet: params.wallet,
              account: params.account,
              contractService: params.contractService,
            },
            RAIL_REGISTERED,
            { tuple: params.historic },
          ),
        resolveSpendMetadata,
        resolveDepositSpendMetadata,
      })
      // A sponsored burn always carries its receipt block; without one it is left to the chain.
      if (exit.burnBlockNumber === undefined) throw new Error("burn receipt has no block")
      return { txHash: exit.burnTxHash, blockNumber: exit.burnBlockNumber }
    },
  })
  return record
}
