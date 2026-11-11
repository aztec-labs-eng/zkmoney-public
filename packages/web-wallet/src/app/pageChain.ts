import { createPublicClient, erc20Abi, type Address, type Hex } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import {
  bridgeOfTuple,
  feeTokenBridge,
  isRetiredRollupSource,
  loadOxideDeployment,
  loadRetiredRollupSources,
  type OxideDeployment,
  type OxideDeploymentTable,
  type PinnedOxideDeployment,
  type SipaIntentName,
} from "@obsidion/core/oxide"
import {
  readDeploymentTable,
  readSipaPortalTerms,
  type BridgeOutProviderId,
  type OxideTokenImmutables,
  type PortalDomain,
  type SipaPortalTerms,
  type WithdrawalExecutor,
} from "@obsidion/sdk"
import {
  DEFAULT_PORTAL_CAPACITY_POLICY,
  ensNames,
  deploymentScans,
  fetchSignupResolverRecord,
  fleetSignerConnector,
  keyedService,
  loadOxideManifestTuple,
  readSavingsVault,
  rpcOriginChain,
  sipaIntentName,
  fixed,
  type BridgeInProvider,
  type BridgeInQuote,
  type BridgeInQuoteRequest,
  type RequestInlinePacket,
  type ScreeningVerdict,
  type Database,
  type PortalCapacityKey,
  type QueryEntry,
  type QueryFactory,
  type RegistryTagResolution,
  type SkySavings,
  type SipaRecordRoute,
} from "@obsidion/front-core"
import { webBroadcasterArtifact, type WebClassArtifactResolver } from "../config/classArtifacts"
import { l1ChainFor, l1Transport, type WebWalletConfig } from "../config/env"
import {
  ASSET_TUPLE_TIMEOUT_MS,
  fleetUrl,
  l1PublicClient,
  loadManifestBridges,
  loadManifestDeployments,
  oxideEnvOf,
  type OxideEnv,
  requireTupleField,
  withRegistryController,
} from "../config/oxideTuple"
import {
  bridgeOfToken,
  portalContract,
  readTokenImmutables,
  readWithRetry,
} from "../features/token/oxideToken"
import type { PageChain, PageFacts } from "../session/pageChain"
import {
  bridgeChainClients,
  bridgeInQueries,
  bridgeInSource,
  type OriginTokenFacts,
} from "../features/deposit/bridgeChains"
import {
  acrossBridgeOut,
  bridgeOutQueries,
  type BridgeOutAsk,
  type BridgeOutChain,
  type BridgeOutPriced,
  type WebBridgeOut,
} from "../features/withdraw/bridgeOutQuote"
import { l1AddressActivities, type L1AddressActivity } from "../features/withdraw/addressFacts"
import { etherfiVerdicts, type EtherfiAddressVerdict } from "../features/withdraw/etherfiCheck"
import {
  simulateSwapForTuple,
  type ExecutorTerms,
  type SwapArgs,
  type SwapQuote,
} from "../features/withdraw/withdrawQuote"
import { swapQuotes } from "../features/withdraw/swapQuotes"
import type { FasterWithdrawalQuote } from "../features/withdraw/useFasterWithdrawal"
import type { AccountlessResolveResult } from "../features/requests/accountlessRequest"
import { profileBridge } from "../session/walletChains"
import type { ArrivalGrid } from "../features/deposit/depositArrival"
import type { DepositTokens } from "../features/sipa/loadDepositFacts"
import { resolveTagViaRegistry } from "../features/contacts/registryResolution"
import { trackerRails, withdrawalReads } from "../features/withdraw/executorReads"
import { activeCapacityKey } from "../features/deposit/capacityStore"
import { withTimeout } from "../lib/withTimeout"
import { CHAIN_READS_PREFIX } from "../platform/storage/storageKeys"

/** The bridge-out provider `id` names, with its routes and quotes; null where the profile has none. */
export type BridgeOutBuilder = (provider: BridgeOutProviderId) => WebBridgeOut | null

// eslint-disable-next-line no-restricted-syntax -- debt
const savings = () => import("../features/savings/savingsGateway")
const depositFacts = () => import("../features/sipa/loadDepositFacts")
const paylinkSource = () => import("../features/paylink/paylinkSource")
const withdrawalFee = () => import("../features/withdraw/withdrawalFee")
const sourceGeneration = () => import("../platform/sourceGeneration")
const depositArrival = () => import("../features/deposit/depositArrival")

/** The rollup's slot grid, off the page's node client, so no read of it opens the wallet. */
export const slotGrids = (query: QueryFactory, node: () => Pick<AztecNode, "getL1Constants">) =>
  query<[], ArrivalGrid>("slotGrid", {
    load: async () => (await depositArrival()).loadArrivalGrid(node()),
  })()

/** How long the accepted tokens wait before a failed read is read again, doubling to 5 min. */
export const DEPOSIT_TOKENS_RETRY_MS = 5_000

/**
 * What a SIPA of the pinned table accepts for each intent. A failure retries while a screen shows
 * them, and a read after the table's reuse window reads it again, so a changed route shows.
 */
export const depositTokenReads = (
  query: QueryFactory,
  page: PageFacts,
  load = async (intent: SipaIntentName) => (await depositFacts()).loadDepositTokens(page, intent),
) =>
  query<[SipaIntentName], DepositTokens>("depositTokens", {
    load,
    stale: DEPLOYMENT_TABLE_TTL_MS,
    retry: { baseMs: DEPOSIT_TOKENS_RETRY_MS, maxMs: 300_000 },
  })

/** What a page's reads start from in place of the manifest: the demo's fixtures. */
export interface PrimedReads {
  tuple: OxideEnvTuple
  deployment?: PinnedOxideDeployment
}

const lower = (address: string) => address.toLowerCase()

/** How long a read of the table's rows is reused. The owner can change a row at any time. */
export const DEPLOYMENT_TABLE_TTL_MS = 30_000

/** How long a failed SIPA terms read waits before it reads again, while a deposit's reason is shown. */
const TERMS_RETRY_MS = 15_000

/** How long a resolver-operator selection is reused. Selecting one scans the deployment's whole
 *  operator log history, and the tag step starts it ahead of the claim. */
export const RESOLVER_OPERATOR_REUSE_MS = 5 * 60_000

/**
 * The page's chain reads over `config`, the profile's class catalog `resolve`, and `primed`. Each
 * read is kept for the page unless its `stale` says otherwise, and its next read reads a failed one
 * again. The tuple and the table come off one manifest fetch, so they always come from one republish.
 */
export function createPageChain(
  config: WebWalletConfig,
  { query, database }: { query: QueryFactory; database: Database },
  resolve?: WebClassArtifactResolver,
  primed?: PrimedReads,
): PageChain & { bridgeOut: BridgeOutBuilder } {
  const { network } = config
  const client = () => l1PublicClient(config)
  const bridgeChainClient = bridgeChainClients(config)
  const scans = deploymentScans(query, client, database.scoped(CHAIN_READS_PREFIX))
  // After an invalidation each fetch revalidates with the host, so a host `max-age` cannot delay
  // a feature.
  let revalidate = false
  const deployment = query<[], PinnedOxideDeployment>("oxideDeployment", {
    load: async () =>
      !revalidate && primed?.deployment
        ? primed.deployment
        : loadOxideDeployment({
            ...config.oxideProfile,
            network,
            ...(revalidate ? { cache: "no-cache" as const } : {}),
          }),
  })()
  const tuple = query<[], OxideEnvTuple>("oxideTuple", {
    load: async (signal) =>
      primed
        ? primed.tuple
        : withRegistryController(config, (await deployment.read(signal)).pinned.tuple),
  })()
  const table = query<[], OxideDeploymentTable>("deploymentTable", {
    load: async (signal) =>
      readDeploymentTable(client(), (await deployment.read(signal)).deployment),
    stale: DEPLOYMENT_TABLE_TTL_MS,
  })()
  const otherManifestSources = query<[], OxideEnvTuple[]>("otherManifestSources", {
    load: () => {
      const pins = (config.sourceRollups ?? []).flatMap((rollup) =>
        rollup.manifestUrl === config.oxideProfile.manifestUrl
          ? []
          : rollup.pins.map((pin) => ({ ...pin, manifestUrl: rollup.manifestUrl })),
      )
      return withTimeout(
        Promise.all(pins.map((pin) => loadOxideManifestTuple({ ...pin, network }))),
        ASSET_TUPLE_TIMEOUT_MS,
      )
    },
  })()
  // A list missing another manifest's bridges is read again on its next read.
  const partial = new WeakSet<OxideEnvTuple[]>()
  const bridges = query<[], OxideEnvTuple[]>("manifestBridges", {
    load: async (signal) => {
      let listedAll = true
      const [listed, others] = await withTimeout(
        Promise.all([
          loadManifestBridges(config.oxideProfile.manifestUrl),
          otherManifestSources.read(signal).catch(() => {
            listedAll = false
            return []
          }),
        ]),
        ASSET_TUPLE_TIMEOUT_MS,
      )
      const list = [...listed, ...others]
      if (!listedAll) partial.add(list)
      return list
    },
    stale: (list) => partial.has(list),
  })()
  const txAmountCap = query<[Address], bigint>("txAmountCap", {
    load: (portal) => readWithRetry(() => portalContract(client(), portal).getTxAmountCap()),
  })
  const tokenImmutables = query<[Address], OxideTokenImmutables>("tokenImmutables", {
    load: (portal) => readTokenImmutables(reads, client, portal),
  })
  const bridgeOf = query<[string], OxideEnvTuple>("bridgeOfToken", {
    load: (token) => bridgeOfToken(reads, token),
    stale: 0,
  })
  const tokenImmutablesOf = query<[string], OxideTokenImmutables>("tokenImmutablesOf", {
    load: async (token, signal) => {
      const { portal } = await bridgeOf(token).read(signal)
      return tokenImmutables(portal as Address).read(signal)
    },
    stale: 0,
  })
  const connect = fleetSignerConnector(config.l1RpcUrl, config.l1Chain)
  const portalTerms = query<[SipaRecordRoute, string | undefined], SipaPortalTerms>(
    "sipaPortalTerms",
    {
      load: async (route, token, signal) => {
        const [{ recordedRowToken }, pinned] = await Promise.all([
          depositFacts(),
          deployment.read(signal),
        ])
        return readSipaPortalTerms(client(), {
          ...route,
          token: recordedRowToken(config, pinned, sipaIntentName(route.intent), token),
        })
      },
      retry: { baseMs: TERMS_RETRY_MS, maxMs: TERMS_RETRY_MS },
    },
  )
  const tagResolutions = query<[string], RegistryTagResolution>("tagResolution", {
    load: (tag) => resolveTagViaRegistry({ config, chain: reads }, tag),
    stale: 0,
  })
  const sipaDeploymentTable = query<[string], OxideDeploymentTable>("sipaDeploymentTable", {
    load: async (forwardingTable, signal) => {
      const { deployment: current } = await deployment.read(signal)
      if (current.forwardingTable?.toLowerCase() === lower(forwardingTable)) {
        return table.read(signal)
      }
      const pinnedPortals = new Set(current.bridges.map(({ portal }) => lower(portal)))
      const others = (await bridges.read(signal))
        .filter(({ portal }) => !pinnedPortals.has(lower(portal)))
        .map(bridgeOfTuple)
      return readDeploymentTable(client(), {
        ...current,
        forwardingTable,
        bridges: [...current.bridges, ...others],
      })
    },
    stale: 0,
  })

  const portalTuples = query<[string, string | undefined], OxideEnvTuple>("portalTuple", {
    load: (portal, expectedGitSha) =>
      withTimeout(
        loadOxideManifestTuple({
          manifestUrl: config.oxideProfile.manifestUrl,
          portal,
          ...(expectedGitSha ? { expectedGitSha } : {}),
          network,
        }),
        ASSET_TUPLE_TIMEOUT_MS,
      ),
  })

  // A failed key retries on the capacity poll's interval, doubling to 5 min, so a failed manifest
  // fetch does not stick until a reload.
  const capacityKeys = query<[string | undefined], PortalCapacityKey>("capacityKey", {
    load: (rowToken) => activeCapacityKey({ config, chain: reads }, rowToken),
    retry: { baseMs: DEFAULT_PORTAL_CAPACITY_POLICY.refreshMs, maxMs: 300_000 },
  })
  const paylinkExecutors = query<[string], WithdrawalExecutor>("paylinkExecutor", {
    load: async (token) => {
      const [{ paylinkTuple }, { withdrawalExecutor }] = await Promise.all([
        paylinkSource(),
        withdrawalFee(),
      ])
      return withdrawalExecutor(reads, await paylinkTuple({ config, chain: reads }, token))
    },
  })
  const retiredMajors = query<[string], string | null>("retiredRollupMajor", {
    load: async (address) =>
      (await (await sourceGeneration()).retiredRollupMajor(config, address)) ?? null,
  })

  let across: WebBridgeOut | undefined
  const bridgeOut: BridgeOutBuilder = (provider) => {
    if (provider !== "across" || profileBridge(config)?.provider !== "across") return null
    const facts = { config, chain: reads }
    across ??= acrossBridgeOut(facts, {
      tupleOf: async (token) => (await paylinkSource()).paylinkTuple(facts, token),
      client: bridgeChainClient,
    })
    return across
  }

  const reads: PageChain & { bridgeOut: BridgeOutBuilder } = {
    oxideTuple: tuple,
    oxideDeployment: deployment,
    /**
     * Fetches the manifest again, so a feature it gained, such as a migration executor, is read in
     * place. The tuple stays: the pinned bridge does not change when a feature is added, and a
     * repoint to another portal goes through the Reload prompt.
     */
    invalidateDeployment: () => {
      revalidate = true
      deployment.refresh()
    },
    /** The fee token's bridge, or the pinned one's own entry, which carries its overlay. */
    feeTokenBridgeTuple: query<[], OxideEnvTuple>("feeTokenBridgeTuple", {
      load: async (signal) => {
        const [pinned, { deployment: current }] = await Promise.all([
          tuple.read(signal),
          deployment.read(signal),
        ])
        const fee = feeTokenBridge(current)
        return !fee || lower(fee.portal) === lower(pinned.portal) ? pinned : fee.tuple
      },
      stale: 0,
    })(),
    deploymentTable: table,
    /**
     * The pinned table's rows, or after a repoint those of the earlier table an address committed
     * to. That table may route a token to a bridge the pinned deployment has since replaced or
     * dropped, so every bridge the manifests list is a candidate.
     */
    sipaDeploymentTable,
    /**
     * Other current deployments sharing the pinned one's L1 chain and name registry: sign-in
     * accepts a passkey still bound to a rollup this profile has cut over from. A failed read stops
     * sign-in from concluding a passkey has no account, so it waits as long as a portal tuple.
     */
    retiredRollupSources: query<[], OxideEnvTuple[]>("retiredRollupSources", {
      load: (signal) =>
        withTimeout(
          Promise.all([
            loadRetiredRollupSources({ ...config.oxideProfile, network }),
            otherManifestSources.read(signal),
          ]).then(async ([listed, others]) => {
            if (!others.length) return listed
            const pinned = await tuple.read(signal)
            return [...listed, ...others.filter((source) => isRetiredRollupSource(source, pinned))]
          }),
          ASSET_TUPLE_TIMEOUT_MS,
        ),
    })(),
    /** Each other manifest's pinned entry for its version's portal: an earlier generation's. */
    otherManifestSources,
    manifestBridges: bridges,
    manifestDeployments: query<[], OxideDeployment[]>("manifestDeployments", {
      load: () => withTimeout(loadManifestDeployments(config), ASSET_TUPLE_TIMEOUT_MS),
    })(),
    portalTuple: (portal, expectedGitSha) => portalTuples(portal, expectedGitSha),
    /** Kept for {@link RESOLVER_OPERATOR_REUSE_MS}: the resolver operator is reused that long. */
    oxideEnv: query<[], OxideEnv>("oxideEnv", {
      load: async (signal) => {
        const pinned = await tuple.read(signal)
        const publicClient = client()
        const record = await fetchSignupResolverRecord(scans, pinned, network)
        return oxideEnvOf(config, pinned, publicClient, record)
      },
      stale: RESOLVER_OPERATOR_REUSE_MS,
    })(),
    tokenImmutables,
    tokenImmutablesOf,
    sipaPortalTerms: (route, token) =>
      portalTerms({ forwardingTable: route.forwardingTable, intent: route.intent }, token),
    tokenMetadata: query<[Address], { symbol: string; decimals: number }>("tokenMetadata", {
      load: async (token) => {
        const publicClient = client()
        const [symbol, decimals] = await Promise.all([
          publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
          publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
        ])
        return { symbol, decimals }
      },
    }),
    txAmountCap,
    currentTxAmountCap: query<[], bigint>("currentTxAmountCap", {
      load: async (signal) =>
        txAmountCap(requireTupleField(await tuple.read(signal), "portal") as Address).read(signal),
    })(),
    capacityKey: (rowToken) => capacityKeys(rowToken),
    portalDomain: query<[Address], PortalDomain>("portalDomain", {
      load: (portal) => portalContract(client(), portal).getPortalDomain(),
    }),
    bridgeOfToken: bridgeOf,
    bridgeChainClient,
    originChain: rpcOriginChain(bridgeChainClient),
    bridgeOut,
    withdrawalRails: keyedService(
      "withdrawalRails",
      { retry: "manual" },
      async (_args, _inputs, signal) => trackerRails(client(), await tuple.read(signal), bridgeOut),
    ),
    ...withdrawalReads(client, query),
    activeWithdrawalExecutor: query<[], WithdrawalExecutor>("activeWithdrawalExecutor", {
      load: async (signal) => {
        const { withdrawalExecutor } = await withdrawalFee()
        return withdrawalExecutor(reads, await tuple.read(signal))
      },
    })(),
    paylinkExecutor: paylinkExecutors,
    /** Its deployment's fleet, sealing to the domain of the portal its immutables name. */
    async teeSignerOfToken(token) {
      const [bridge, { portal }] = await Promise.all([
        bridgeOf(token).read(),
        tokenImmutablesOf(token).read(),
      ])
      return reads
        .connectFleetSigner(fleetUrl(config, bridge), portal.toString() as Address)
        .ready()
    },
    /**
     * One signer per fleet and portal domain. A `FleetSigner` re-pins itself when its enclave goes
     * and holds nothing to release, so it has no dispose.
     */
    connectFleetSigner: keyedService(
      "fleetSigner",
      { retry: "manual" },
      ([fleet, portal]: [string, Hex]) => connect(fleet, portal),
    ),
    // Loaded on first read, so building the reads loads no Savings code.
    skySavings: query<[], SkySavings | null>("skySavings", {
      load: async () => (await (await savings()).readSkySavings({ config, chain: reads })) ?? null,
    })(),
    savingsTuple: query<[], OxideEnvTuple | null>("savingsTuple", {
      load: async () => (await savings()).savingsTuple(reads),
    })(),
    savingsVault: query<[Address], Address>("savingsVault", {
      load: (portal) => readSavingsVault(client(), portal),
    }),
    tagResolution: (tag) => tagResolutions(tag.toLowerCase()),
    retiredRollupMajor: retiredMajors,
    broadcasterArtifact: webBroadcasterArtifact(resolve),
    ensClient: () => {
      const chain = l1ChainFor(config.l1ChainId)
      if (!chain.contracts?.ensUniversalResolver) return null
      return createPublicClient({ chain, transport: l1Transport(config) })
    },
    ensName: ensNames(query, () => reads.ensClient()),
    scans,
  }
  return reads
}

/** What a demo page reads in place of each remote value. */
export interface PageLoaders {
  bridgeOutQuote: (facts: PageFacts, ask: BridgeOutAsk) => Promise<BridgeOutPriced>
  bridgeOutRoutes: (token: string) => Promise<BridgeOutChain[]>
  bridgeInQuote: (request: BridgeInQuoteRequest) => Promise<BridgeInQuote>
  originBalance: (chainId: number, token: Address, account: Address) => Promise<bigint>
  originToken: (chainId: number, token: Address) => Promise<OriginTokenFacts>
  l1AddressActivity: (address: Address) => Promise<L1AddressActivity>
  etherfiVerdict: (address: Address) => Promise<EtherfiAddressVerdict>
  screening: (address: string) => Promise<ScreeningVerdict>
  ensAddress: (name: string) => Promise<Address | null>
  /** A swap route's price, and the active executor's terms the direct route prices. */
  swapQuote: {
    simulate: (args: SwapArgs) => Promise<SwapQuote>
    executor: () => Promise<ExecutorTerms>
  }
  /** One quote of the faster withdrawal's reads. */
  fasterOffer: (signal: AbortSignal) => Promise<FasterWithdrawalQuote>
  /** The rollup's slot grid, which the deposit arrival time follows. */
  slotGrid: () => Promise<ArrivalGrid>
  /** A pay page's request, resolved to its payee's address. */
  accountlessRequest: (packet: RequestInlinePacket) => Promise<AccountlessResolveResult>
}

/** The page's bridge and L1-address Services and Queries, each built once. */
export type PageReads = ReturnType<typeof createPageReads>

/**
 * The page's bridge provider and the Queries over it, the bridge-out quotes and routes, and the L1
 * address reads. `dev` puts a demo page's bridge and loaders in place.
 */
export function createPageReads(
  facts: PageFacts,
  query: QueryFactory,
  dev: {
    /** The bridge-out providers the page builds, by id; the queries price asks on them. */
    bridgeOut: BridgeOutBuilder
    bridgeInProvider?: BridgeInProvider
    loaders?: Partial<PageLoaders>
  },
) {
  const { config, chain } = facts
  const loaders = dev.loaders ?? {}
  // A token's decimals never change: each is read once per page.
  const tokenDecimals = query<[number, Address], number>("bridgeTokenDecimals", {
    load: (chainId, token) =>
      (chainId === config.l1ChainId
        ? l1PublicClient(config)
        : chain.bridgeChainClient(chainId)
      ).readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  })
  const source = bridgeInSource(
    config,
    (chainId, token) => tokenDecimals(chainId, lower(token) as Address).read(),
    dev.bridgeInProvider,
  )
  const bridgeInProvider = fixed("bridgeInProvider", source.provider)
  const bridgeInDeposits = fixed("bridgeInDeposits", source.deposits)
  const swapStub = loaders.swapQuote
  const activeExecutorTerms: QueryEntry<ExecutorTerms> = swapStub
    ? query<[], ExecutorTerms>("activeExecutorTerms", { load: () => swapStub.executor() })()
    : chain.activeWithdrawalExecutor
  return {
    /** The profile's bridge-in provider; null where it names none. */
    bridgeInProvider,
    /** The provider's deposits by id; null where it has no such lookup. */
    bridgeInDeposits,
    ...bridgeInQueries(query, {
      client: chain.bridgeChainClient,
      origin: chain.originChain,
      provider: bridgeInProvider,
      loaders,
    }),
    /** The deposit fee of the row for `token`, decimal in its token, read again on every read. */
    rowDepositFee: query<[Address], string>("rowDepositFee", {
      load: async (token) =>
        (await (await depositFacts()).loadDepositDisplayFacts(facts, { settlesIn: token })).fee,
      stale: 0,
    }),
    ...bridgeOutQueries(query, facts, {
      bridgeOut: dev.bridgeOut,
      quote: loaders.bridgeOutQuote,
      routes: loaders.bridgeOutRoutes,
    }),
    l1AddressActivity: loaders.l1AddressActivity
      ? query<[Address], L1AddressActivity>("l1AddressActivity", {
          load: loaders.l1AddressActivity,
          stale: 0,
        })
      : l1AddressActivities(query, () => l1PublicClient(config)),
    etherfiVerdict: loaders.etherfiVerdict
      ? query<[Address], EtherfiAddressVerdict>("etherfiVerdict", {
          load: loaders.etherfiVerdict,
          stale: 0,
        })
      : etherfiVerdicts(query, config),
    /** The swap simulations a withdrawal prices its route with, keyed by its inputs. */
    swapQuote: swapQuotes(query, {
      active: (signal) => chain.oxideTuple.read(signal),
      token: async (token) => (await paylinkSource()).paylinkTuple(facts, token),
      simulate: swapStub
        ? (args) => swapStub.simulate(args)
        : (args, tuple) => simulateSwapForTuple(args, tuple, facts),
    }),
    /** The active executor's fee and beneficiary, which the direct route prices. */
    activeExecutorTerms,
    /** A demo page's stand-ins for the remote reads no Query holds; empty on any other page. */
    loaders,
  }
}
