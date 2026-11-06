/**
 * What every part of the browser's SIPA rail reads: the pinned deployment, its table's rows, and
 * three session resources, the account's SIPA keys, the PXE's SIPA discovery setup and the
 * resolver's deployments.
 */
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { GrumpkinScalar } from "@aztec-labs/foundation/curves/grumpkin"
import type { Address } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  BroadcasterContract,
  ContractService,
  DEFAULT_CONTRACTS,
  predictAccountAddressLocally,
  sipaNullifierHidingKey,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import {
  deriveBootstrapKey,
  deriveStealthKey,
  readResolverDeployments,
  resource,
  setupSipaDiscovery,
  sipaRowFundingTokens,
  sipaRows,
  type ResolverDeployment,
  type Resource,
  type SipaRow,
} from "@obsidion/front-core"
import { getWebBroadcasterArtifact } from "../../config/classArtifacts"
import { getConfig, type WebWalletConfig } from "../../config/env"
import {
  getDeploymentTable,
  getOxideTuple,
  l1PublicClient,
  requireTupleField,
} from "../../config/oxideTuple"
import { tokenMetadata } from "../sipa/loadDepositFacts"

/** The pinned deployment's token, which every self-derived address names before it is funded. */
export async function pinnedToken(
  config: WebWalletConfig,
  tuple: OxideEnvTuple,
): Promise<{ address: Address; symbol: string; decimals: number }> {
  const address = requireTupleField(tuple, "token") as Address
  return { address, ...(await tokenMetadata(config, address)) }
}

/** The pinned table's rows the pipeline claims through, each token's metadata read off L1. */
export async function railRows(config: WebWalletConfig): Promise<SipaRow[]> {
  const table = await getDeploymentTable(config)
  return sipaRows(table, config.l1ChainId, (token) => tokenMetadata(config, token))
}

/** The unlocked account's keys the rail derives, observes and claims with. */
export interface SipaKeys {
  account: ObsidionAccount
  recipient: AztecAddress
  msk: Fr
  stealthKey: ReturnType<typeof deriveStealthKey>
  /** Keys the account's deposit nullifiers. */
  nullifierHidingKey: GrumpkinScalar
  /** The account the recovery commitment of every self-derived address binds. */
  recoveryAccount: Address
}

/** The account's SIPA keys, rebuilt with the account; pending while the key cannot be read. */
export function sipaKeysResource(
  wallet: Resource<ObsidionWallet>,
  account: Resource<ObsidionAccount>,
  secretKey: () => Promise<Fr | null | undefined>,
): Resource<SipaKeys> {
  return resource(
    "sipaKeys",
    { from: [wallet, account], backoff: { baseMs: 5_000, maxMs: 60_000 } },
    async ([, account]) => {
      const msk = await secretKey()
      if (!msk) return undefined
      const tuple = await getOxideTuple(getConfig())
      return {
        account,
        recipient: account.getAddress(),
        msk,
        stealthKey: deriveStealthKey(msk),
        nullifierHidingKey: await sipaNullifierHidingKey(account),
        recoveryAccount: predictAccountAddressLocally(
          requireTupleField(tuple, "accountFactory") as Address,
          deriveBootstrapKey(msk).address,
        ),
      }
    },
  )
}

/** The PXE's SIPA discovery setup, and the broadcaster it registered. */
export interface SipaDiscovery {
  broadcaster: BroadcasterContract
}

/**
 * Registers the broadcaster contract, the resolver and the sponsor senders in the PXE. The tagging
 * pass needs their preimages to read this wallet's own `SIPA` events, so a broadcast needs it too.
 * Built on first demand.
 */
export function sipaDiscoveryResource(wallet: Resource<ObsidionWallet>): Resource<SipaDiscovery> {
  return resource(
    "sipaDiscovery",
    { from: [wallet], lazy: true, backoff: { baseMs: 5_000, maxMs: 300_000 } },
    async ([wallet]) => {
      const config = getConfig()
      const tuple = await getOxideTuple(config)
      const { address: sponsorFpc } = await ContractService.getInstance().getContractRecord(
        DEFAULT_CONTRACTS.claimFpc,
      )
      await setupSipaDiscovery({
        artifactFor: (address) => getWebBroadcasterArtifact(wallet, address),
        pxe: wallet.pxe as never,
        node: wallet.node as never,
        publicClient: l1PublicClient(config),
        tuple,
        network: config.network,
        sponsorFpc,
      })
      const address = requireTupleField(tuple, "l2Broadcaster")
      // `.at()` registers the contract in the PXE, so it is built once per wallet.
      const broadcaster = BroadcasterContract.at(
        AztecAddress.fromStringUnsafe(address),
        await getWebBroadcasterArtifact(wallet, address),
        wallet as never,
      )
      return { broadcaster }
    },
  )
}

/** The resolver's deployments for the account's keys, and when they were read, ms epoch. */
export interface ResolverDeploymentsRead {
  at: number
  deployments: ResolverDeployment[]
}

/** Read on first demand. Its reader rebuilds it once stale or failed: `retry()`. */
export function resolverDeploymentsResource(
  keys: Resource<SipaKeys>,
): Resource<ResolverDeploymentsRead> {
  return resource(
    "resolverDeployments",
    { from: [keys], lazy: true, backoff: "manual" },
    async ([keys]) => {
      const config = getConfig()
      const tuple = await getOxideTuple(config)
      const [meta, rows] = await Promise.all([pinnedToken(config, tuple), railRows(config)])
      const deployments = await readResolverDeployments({
        publicClient: l1PublicClient(config),
        sources: [
          {
            tuple,
            tokens: [
              meta,
              ...sipaRowFundingTokens(rows).filter(
                (t) => t.address.toLowerCase() !== meta.address.toLowerCase(),
              ),
            ],
          },
        ],
        recoveryAccount: keys.recoveryAccount,
        recipient: keys.recipient,
        stealthPublicKey: keys.stealthKey.publicKey,
      })
      return { at: Date.now(), deployments }
    },
  )
}
