import {
  accountRecordStale,
  BalanceStorage,
  createMetadataMigrationSession,
  pubkeyToR1KeyArg,
  readSavingsPrice,
  readSavingsVault,
  savingsValue,
  SIPADepositStore,
  UpgradeActivity,
  WalletSyncCoordinator,
} from "@obsidion/front-core"
import {
  createLocalMetadataMigrationSource,
  FrozenMetadataMigrationSource,
  frozenRuntimeFromSourceGeneration,
  migrationRouteFor,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
} from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address } from "viem"
import { getConfig } from "../../config/env"
import {
  getFeeTokenBridgeTuple,
  getOxideDeployment,
  getOxideTuple,
  getRetiredRollupSources,
  l1MulticallClient,
} from "../../config/oxideTuple"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { withSourceSigner } from "../../platform/sourceGeneration"
import { getActiveCredentialId, getActiveStorageId } from "../../platform/storage/activeStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { SessionChangedError } from "../../platform/auth/sessionErrors"
import { collectOnboardingKeys } from "../onboarding/oxideOnboarding"
import { portalContract } from "../token/oxideToken"
import { historicTokenContext, sourceChain } from "./historicTokenContext"
import { sourceFrozenEscrows, sourceLinkRows } from "./sourceFrozenEscrows"
import { sourceSavingsDeposits } from "./sourceSavingsDeposits"
import { sourceSweptDeposits } from "./sourceSipaSources"
import { oldVersionScope } from "./oldVersionBalance"
import { FREEZE_POLL_MS, ManifestUnavailableError, pause } from "./freezeWatch"

export const webMetadataMigrationKey = (
  current: OxideEnvTuple,
  historic: OxideEnvTuple,
  account: ObsidionAccount,
) =>
  `metadata-migration/${current.portal.toLowerCase()}/${historic.portal.toLowerCase()}/${account.getAddress()}`

/** `accountRecordStale` with this session's key and the pinned deployment. */
export async function webAccountRecordStale(account: ObsidionAccount): Promise<boolean> {
  const config = getConfig()
  const [keys, current, metadataCurrent] = await Promise.all([
    collectOnboardingKeys(account),
    getOxideTuple(config),
    getFeeTokenBridgeTuple(config),
  ])
  return accountRecordStale({
    account,
    current,
    metadataCurrent,
    secretKey: keys.secretKey,
    client: l1MulticallClient(config),
  })
}

/** Browser signing and storage adapters around the shared durable migration session. */
export async function createWebMetadataMigration(params: {
  wallet: ObsidionWallet
  account: ObsidionAccount
  contractService: ContractService
  toTokenService: TokenService
  historic: OxideEnvTuple
  current: OxideEnvTuple
  recoveryOnly?: boolean
  /** A withdrawal to L1 in place of the upgrade, which needs no migration route. */
  withdrawal?: boolean
  /** A withdrawal's L1 submitter, which takes the source's subsidy. */
  tipRecipient?: Address
}) {
  const config = getConfig()
  // Folds contract reads, such as the migration subsidy's, into Multicall3 calls.
  const client = l1MulticallClient(config)
  const keys = await collectOnboardingKeys(params.account)
  const storageId = getActiveStorageId()
  const credentialId = getActiveCredentialId()
  if (!storageId) throw new SessionChangedError()
  // The run is one session's: another account, or this account under another passkey, ends it.
  const checkSession = () => {
    if (getActiveStorageId() !== storageId || getActiveCredentialId() !== credentialId) {
      throw new SessionChangedError()
    }
  }
  const key = webMetadataMigrationKey(params.current, params.historic, params.account)
  const hasSource = params.historic.portal.toLowerCase() !== params.current.portal.toLowerCase()
  const chain = hasSource
    ? await sourceChain(
        { wallet: params.wallet, account: params.account },
        params.current,
        params.historic,
      )
    : undefined
  const sourceContext =
    chain?.kind === "pxe"
      ? await historicTokenContext(chain.wallet, chain.account, params.historic)
      : undefined
  const depositDescriptors = async () => {
    const scan = {
      chain: chain!,
      tuple: params.historic,
      publicClient: client,
      masterSecret: keys.secretKey,
      scanHead: await client.getBlockNumber({ cacheTime: 0 }),
    }
    const [sipas, savings] = await Promise.all([
      sourceSweptDeposits(scan),
      sourceSavingsDeposits({
        ...scan,
        sourceTuples: [params.historic, ...(await getRetiredRollupSources(config))],
      }),
    ])
    return [...new Map([...sipas.descriptors, ...savings].map((d) => [d.messageKey, d])).values()]
  }
  /**
   * The destination deployment and the source's migration route on it. A feature for the source
   * that cannot be used (two features, missing fields, another destination portal) is logged and
   * reads as none: that source cannot move yet, and no other source is blocked.
   */
  const usableRoute = async (destinationPortal: Address, operationExecutor: Address) => {
    const { deployment } = await getOxideDeployment(config).catch((error) => {
      throw new ManifestUnavailableError(error)
    })
    try {
      const route = migrationRouteFor(
        deployment,
        params.historic.portal as Address,
        destinationPortal,
        operationExecutor,
      )
      return { deployment, route }
    } catch (error) {
      console.warn(
        `[migration] the migration feature for ${params.historic.portal} is unusable:`,
        error,
      )
      return { deployment: undefined, route: undefined }
    }
  }
  const paylinkRows = () =>
    sourceLinkRows({ tuple: params.historic, current: params.current, storageId })
  const lock = <T>(fn: () => Promise<T>) =>
    navigator.locks.request(`${storageId}/${key}`, async () => {
      checkSession()
      return fn()
    })
  const session = await createMetadataMigrationSession({
    wallet: params.wallet,
    account: params.account,
    contracts: params.contractService,
    tokenService: params.toTokenService,
    current: params.current,
    metadataCurrent: await getFeeTokenBridgeTuple(config).catch((error) => {
      throw new ManifestUnavailableError(error)
    }),
    ...(params.recoveryOnly ? { recoveryOnly: true } : {}),
    network: config.network,
    client,
    secretKey: keys.secretKey,
    key,
    activity: UpgradeActivity.get(webStorage),
    deposits: SIPADepositStore.get(webStorage),
    confirmBalance: () => WalletSyncCoordinator.confirmBalance(),
    holdings: async (amount, anchor) => {
      checkSession()
      const value =
        params.current.portal.toLowerCase() === config.oxideProfile.portal.toLowerCase()
          ? amount
          : savingsValue(
              amount,
              (
                await readSavingsPrice(
                  client,
                  await readSavingsVault(client, params.current.portal as Address),
                )
              ).sharePrice,
            )
      checkSession()
      await BalanceStorage.get(webStorage).updateBalance(
        oldVersionScope(params.historic.portal, params.account.getAddress().toString()),
        params.historic.l2Token,
        value,
        anchor,
        { strict: true },
      )
    },
    storage: {
      getItem: async (key) => {
        checkSession()
        return webStorage.getItem(key)
      },
      setItem: async (key, value) => {
        checkSession()
        await webStorage.setItem(key, value)
      },
    },
    // A pass holds this lock from start to end, and a gated send inside it waits for its turn on
    // the prover. A user flow that then asks for this lock would wait on that send, which waits on
    // the user flow. The mount prevents it: a followed source is never offered or queued. Keep it
    // so, or take the prover turn before the lock.
    lock,
    passkey: {
      publicKey: pubkeyToR1KeyArg(keys.pubkeyHex),
      signChallenge: (digest, opts) => {
        checkSession()
        return getAuthService().signMetadataChallenge(digest, opts)
      },
    },
    source: async (context, batches, savedRefundSigner, beforeSourceApproval) => {
      if (chain?.kind === "generation") {
        // A frozen source moves only through its destination's migration executor. The probe
        // lists a source with no usable feature as waiting, so no run reaches here without one.
        // A withdrawal to the user's own address needs none.
        const { route } = await usableRoute(
          context.destination.portal,
          context.destination.operationExecutor,
        )
        if (!route && !params.withdrawal)
          throw new Error(
            `The new version lists no migration route for ${params.historic.portal} yet`,
          )
        const generation = await chain.session.refundRuntime({
          tuple: params.historic,
          tipRecipient: params.tipRecipient ?? context.destination.operationExecutor,
          depositDescriptors,
          paylinkRows,
        })
        // Its passkey prompts go through the saved signer, as a local source's do.
        const runtime = {
          ...generation,
          build: (...args: Parameters<typeof generation.build>) =>
            withSourceSigner(
              (sign) => {
                const saved = savedRefundSigner((challenge) => sign(challenge))
                return (challenge) => saved(Buffer.from(challenge))
              },
              () => generation.build(...args),
            ),
        }
        const asset = await portalContract(client, context.destination.portal).getUnderlying()
        return new FrozenMetadataMigrationSource({
          ...context,
          client,
          wallet: params.wallet,
          batches,
          runtime: frozenRuntimeFromSourceGeneration(
            runtime,
            beforeSourceApproval,
            route && { route, client },
          ),
          destinationAsset: asset.toString() as Address,
        })
      }
      if (!sourceContext)
        return {
          identity: "no-source-deployment",
          state: async () => "empty" as const,
          recoverRemaining: async () => {},
          remainingComplete: async () => true,
        }
      return createLocalMetadataMigrationSource({
        ...context,
        client,
        wallet: params.wallet,
        teeSigner: sourceContext.teeSigner,
        account: params.account,
        batches,
        // A migration feature for the source portal routes its refunds through the executor.
        destinationDeployment: (
          await usableRoute(context.destination.portal, context.destination.operationExecutor)
        ).deployment,
        wrapRefundSigner: savedRefundSigner,
        source: { tuple: params.historic, tokenService: sourceContext.tokenService },
        sourceChain: chain?.kind === "pxe" ? chain : undefined,
        depositDescriptors,
        withdrawal: params.withdrawal,
        tipRecipient: params.tipRecipient,
        escrows: async () =>
          sourceFrozenEscrows({
            chain:
              chain?.kind === "pxe" ? chain : { wallet: params.wallet, account: params.account },
            tuple: params.historic,
            masterSecret: keys.secretKey,
            rows: await paylinkRows(),
          }),
      })
    },
  })
  /** Held by an upgrade run, so a withdrawal never refunds the funds a run plans. */
  return { ...session, lock }
}

/**
 * {@link createWebMetadataMigration}, tried again while the manifest cannot be read: a network error
 * never shows, and the caller stays in its checking or waiting state. `onUnavailable` hears of each
 * failed read. `signal` stops it.
 */
export async function createWebMetadataMigrationQuietly(
  params: Parameters<typeof createWebMetadataMigration>[0],
  signal: AbortSignal,
  retryMs = FREEZE_POLL_MS,
  onUnavailable?: () => void,
): ReturnType<typeof createWebMetadataMigration> {
  for (;;) {
    try {
      return await createWebMetadataMigration(params)
    } catch (error) {
      if (!(error instanceof ManifestUnavailableError) || signal.aborted) throw error
      console.warn("[migration] the manifest could not be read; trying again:", error)
      onUnavailable?.()
      await pause(retryMs, signal)
    }
  }
}
