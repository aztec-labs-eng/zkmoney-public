import type { OxideEnvTuple } from "@obsidion/core/types"
import type {
  DeploymentHoldings,
  Holding,
  OxideDeployment,
  OxideDeploymentTable,
  PinnedOxideDeployment,
  SkyEscrowHolding,
} from "@obsidion/core/oxide"
import type {
  DeploymentScans,
  EnsClient,
  EnsNames,
  OriginChain,
  HoldingPrice,
  PortalCapacityKey,
  RegistryTagResolution,
  QueryEntry,
  Service,
  SipaRecordRoute,
  BridgeOutTracking,
  TrackerRails,
} from "@obsidion/front-core"
import type {
  BridgeOutProviderId,
  OxideTokenImmutables,
  PortalDomain,
  RegisteredTeeSigner,
  SipaPortalTerms,
  SwapOnWithdrawSimulator,
  WithdrawalExecutor,
  WithdrawalExecutorKind,
} from "@obsidion/sdk"
import type { Address, Chain, Hex, PublicClient, Transport } from "viem"
import type { webBroadcasterArtifact } from "../config/classArtifacts"
import type { WebWalletConfig } from "../config/env"
import type { OxideEnv } from "../config/oxideTuple"

/** A Sky holding's price, with the holding. */
export type SavingsPrice = HoldingPrice & { holding: SkyEscrowHolding }

/** A Sky holding's price read: its price, or `failed` when its read failed with no earlier one. */
export type SavingsPriceRead = SavingsPrice | { holding: SkyEscrowHolding; failed: true }

/**
 * The page's manifest and chain reads, queries built once per page over its config: every session
 * of the page shares one manifest fetch, so the tuple and the table come from one republish. A
 * member that takes arguments is a keyed read: it returns one entry per key.
 */
export interface PageChain {
  /** The pinned bridge's tuple. */
  oxideTuple: QueryEntry<OxideEnvTuple>
  /** The pinned deployment with every bridge. */
  oxideDeployment: QueryEntry<PinnedOxideDeployment>
  /** Fetches the deployment again, revalidating with the host from then on. */
  invalidateDeployment(): void
  /** The fee token's bridge, where registrations and metadata updates settle. */
  feeTokenBridgeTuple: QueryEntry<OxideEnvTuple>
  /** The pinned table's rows. */
  deploymentTable: QueryEntry<OxideDeploymentTable>
  /** The table a SIPA's forwarding table commits to. */
  sipaDeploymentTable(forwardingTable: string): QueryEntry<OxideDeploymentTable>
  /** The retired rollups' tuples. */
  retiredRollupSources: QueryEntry<OxideEnvTuple[]>
  /** The manifests' other live deployments. */
  otherManifestSources: QueryEntry<OxideEnvTuple[]>
  /** Every bridge the manifests list. */
  manifestBridges: QueryEntry<OxideEnvTuple[]>
  /** Every deployment the manifest lists. */
  manifestDeployments: QueryEntry<OxideDeployment[]>
  /** The manifest tuple of `portal`. */
  portalTuple(portal: string, expectedGitSha?: string): QueryEntry<OxideEnvTuple>
  /** The oxide env every onboarding rail builds. */
  oxideEnv: QueryEntry<OxideEnv>
  /** The immutables of the token `portal` binds. */
  tokenImmutables(portal: Address): QueryEntry<OxideTokenImmutables>
  /** The published immutables of `token`, checked against its portal. */
  tokenImmutablesOf(token: string): QueryEntry<OxideTokenImmutables>
  /**
   * The terms of the row a recorded SIPA's funds settle on: the row of `token`, the token they are
   * in, or the intent's settlement row while none is recorded.
   */
  sipaPortalTerms(route: SipaRecordRoute, token: string | undefined): QueryEntry<SipaPortalTerms>
  /** `token`'s ERC-20 symbol and decimals, both immutable. */
  tokenMetadata(token: Address): QueryEntry<{ symbol: string; decimals: number }>
  /** The portal's `TX_AMOUNT_CAP()`. */
  txAmountCap(portal: Address): QueryEntry<bigint>
  /** The pinned deployment's `TX_AMOUNT_CAP()`. */
  currentTxAmountCap: QueryEntry<bigint>
  /** The capacity bucket new deposits of `rowToken`'s row fund, the pinned bridge's when unset. */
  capacityKey(rowToken?: string): QueryEntry<PortalCapacityKey>
  /** The domain withdrawal messages of `portal` hash under. */
  portalDomain(portal: Address): QueryEntry<PortalDomain>
  /** The manifest bridge that lists `token`. */
  bridgeOfToken(token: string): QueryEntry<OxideEnvTuple>
  /** The terms of the withdrawal executor at `address`. */
  withdrawalExecutorAt(
    address: Address,
    kind?: WithdrawalExecutorKind,
  ): QueryEntry<WithdrawalExecutor>
  /** The pinned deployment's plain withdrawal executor, checked to serve its portal. */
  activeWithdrawalExecutor: QueryEntry<WithdrawalExecutor>
  /** The plain withdrawal executor of the deployment a paylink in `token` was made on. */
  paylinkExecutor(token: string): QueryEntry<WithdrawalExecutor>
  /** The portal the withdrawal executor at `address` serves. */
  executorPortalAt(address: Address): QueryEntry<Address>
  /** The withdrawal subsidy the executor at `address` created. */
  executorSubsidyAt(address: Address): QueryEntry<Address>
  /** The public client of a bridge chain the profile lists, one per chain; another throws. */
  bridgeChainClient(chainId: number): PublicClient<Transport, Chain>
  /** Reads on the bridge chains over {@link bridgeChainClient}. */
  originChain: OriginChain
  /** The bridge-out `provider`, one per page; null where the profile does not configure it. */
  bridgeOut(provider: BridgeOutProviderId): BridgeOutTracking | null
  /** The withdrawal tracker's L1 readers; null where the pinned tuple has no withdrawal rails. */
  withdrawalRails(): Service<TrackerRails | null>
  /** The swap-on-withdraw simulator over `tuple`'s escrow factory, executor and token. */
  swapSimulator(tuple: OxideEnvTuple): Service<SwapOnWithdrawSimulator>
  /** The co-signer of `token`'s deployment. */
  teeSignerOfToken(token: string): Promise<RegisteredTeeSigner>
  /** The co-signer of `fleet` for `portal`'s domain: one per fleet and domain. */
  connectFleetSigner(fleet: string, portal: Hex): Service<RegisteredTeeSigner>
  /** The pinned deployment's holdings. */
  holdings: QueryEntry<DeploymentHoldings>
  /** A holding's share price and rate, read on L1. */
  holdingPrice(holding: Pick<Holding, "held">): QueryEntry<HoldingPrice>
  /**
   * Savings' price: the profile's Sky holding's, else the deployment's first Sky holding's, which
   * old versions' Savings shares are worth. Null where the deployment has none.
   */
  savingsPrice: QueryEntry<SavingsPrice | null>
  /**
   * Each Sky holding's price, the profile's first, each read on its own: a holding whose read fails
   * keeps its earlier price, or reads `failed`, and the others keep theirs.
   */
  savingsPrices: QueryEntry<readonly SavingsPriceRead[]>
  broadcasterArtifact: ReturnType<typeof webBroadcasterArtifact>
  /** `tag`'s Registry resolution; a read once it settles reads again. */
  tagResolution(tag: string): QueryEntry<RegistryTagResolution>
  /** The Aztec major of the retired rollup at `address`; null for the active or an unknown one. */
  retiredRollupMajor(address: string): QueryEntry<string | null>
  /** The L1's ENS client, or null when that chain has no ENS registry (a local chain). */
  ensClient(): EnsClient | null
  /** ENS primary names over {@link ensClient}, one entry per address. */
  ensName: EnsNames
  /** Each deployment's resolver-operator records, read past a saved cursor. */
  scans: DeploymentScans
}

/** What a page-wide read takes: the page's config and its memoized reads. */
export interface PageFacts {
  config: WebWalletConfig
  chain: PageChain
}
