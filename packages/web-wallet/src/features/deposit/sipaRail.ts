/**
 * What every part of the browser's SIPA rail reads: the pinned deployment, its table's rows, the
 * account's SIPA keys, the PXE's SIPA discovery setup and the resolver's deployments.
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
  deriveSelfSipaKey,
  deriveStealthKey,
  keyedService,
  readResolverDeployments,
  service,
  setupSipaDiscovery,
  WalletError,
  sipaRowFundingTokens,
  sipaRows,
  type KeyedService,
  type QueryFactory,
  type ResolverDeployment,
  type Service,
  type SipaRow,
} from "@obsidion/front-core"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import type { PageFacts } from "../../session/pageChain"
import { tokenMetadata } from "../sipa/loadDepositFacts"

/** The pinned deployment's token, which every self-derived address names before it is funded. */
export async function pinnedToken(
  page: PageFacts,
  tuple: OxideEnvTuple,
): Promise<{ address: Address; symbol: string; decimals: number }> {
  const address = requireTupleField(tuple, "token") as Address
  return { address, ...(await tokenMetadata(page, address)) }
}

/** The pinned table's rows the pipeline claims through, each token's metadata read off L1. */
export async function railRows({ config, chain }: PageFacts): Promise<SipaRow[]> {
  const table = await chain.deploymentTable.read()
  return sipaRows(table, config.l1ChainId, (token) => tokenMetadata({ chain }, token))
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
  /** The account's address: a query reads keys by it. */
  toString(): string
}

/** The keys the resolver's and the account's own address windows derive with. */
export const windowKeys = ({ stealthKey, msk, recipient }: SipaKeys) => ({
  stealthScalar: stealthKey.scalar,
  selfSipaKey: deriveSelfSipaKey(msk),
  recipient,
})

/** The account's SIPA keys, rebuilt with the account. */
export function openSipaKeys(
  page: PageFacts,
  wallet: Service<ObsidionWallet>,
  account: Service<ObsidionAccount>,
  secretKey: () => Promise<Fr | null | undefined>,
): Service<SipaKeys> {
  return service(
    "sipaKeys",
    { from: [wallet, account], retry: { baseMs: 5_000, maxMs: 60_000 } },
    async ([, account]): Promise<SipaKeys> => {
      const msk = await secretKey()
      // The account unlocks only with the key, so it is held while the account is.
      if (!msk) throw new WalletError("account.unlockFailed", "no key for the SIPA keys")
      const tuple = await page.chain.oxideTuple.read()
      const recipient = account.getAddress()
      return {
        account,
        recipient,
        toString: () => recipient.toString(),
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
 * Built once something asks for it.
 */
export function openSipaDiscovery(
  { config, chain }: PageFacts,
  wallet: Service<ObsidionWallet>,
  contractService: Service<ContractService>,
): KeyedService<[], SipaDiscovery> {
  return keyedService(
    "sipaDiscovery",
    { from: [wallet, contractService], retry: { baseMs: 5_000, maxMs: 300_000 } },
    async (_, [wallet, contractService]) => {
      const tuple = await chain.oxideTuple.read()
      const { address: sponsorFpc } = await contractService.getContractRecord(
        DEFAULT_CONTRACTS.claimFpc,
      )
      await setupSipaDiscovery({
        artifactFor: (address) => chain.broadcasterArtifact(wallet, address),
        pxe: wallet.pxe as never,
        node: wallet.node as never,
        scans: chain.scans,
        publicClient: l1PublicClient(config),
        tuple,
        network: config.network,
        sponsorFpc,
      })
      const address = requireTupleField(tuple, "l2Broadcaster")
      // `.at()` registers the contract in the PXE, so it is built once per wallet.
      const broadcaster = BroadcasterContract.at(
        AztecAddress.fromStringUnsafe(address),
        await chain.broadcasterArtifact(wallet, address),
        wallet as never,
      )
      return { broadcaster }
    },
  )
}

/** How long one read of the resolver deployments serves the window. */
const RESOLVER_DEPLOYMENTS_TTL_MS = 15 * 60_000

/** The resolver's deployments for the account's keys, read again once stale or after a failure. */
export function resolverDeployments(query: QueryFactory, page: PageFacts) {
  const { config, chain } = page
  return query<[SipaKeys], ResolverDeployment[]>("resolverDeployments", {
    load: async (keys) => {
      const tuple = await chain.oxideTuple.read()
      const [meta, rows] = await Promise.all([pinnedToken(page, tuple), railRows(page)])
      return readResolverDeployments({
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
    },
    stale: RESOLVER_DEPLOYMENTS_TTL_MS,
  })
}

export type ResolverDeployments = ReturnType<typeof resolverDeployments>
