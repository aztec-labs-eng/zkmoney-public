import { createPublicClient, parseAbi, type Address, type Hex, type PublicClient } from "viem"
import { withTimeout } from "../lib/withTimeout"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { isAllZeroHex } from "@obsidion/core/oxide"
import { MULTICALL3_ADDRESS } from "@obsidion/sdk"
import {
  fetchSignupResolverRecord,
  loadOxideManifestTuple,
  oxideEnvFromTuple,
  resolveOxideAccountFactory,
} from "@obsidion/front-core"
import { loadRetiredRollupSources } from "@obsidion/core/oxide"
import { l1Transport, type WebWalletConfig } from "./env"

let cached: { key: string; tuple: Promise<OxideEnvTuple> } | undefined

const cacheKey = (config: WebWalletConfig) =>
  `${config.oxideProfile.manifestUrl}|${config.oxideProfile.portal}`

/** Dev demo seam: satisfy the profile from a fixture so nothing dials the env registry. */
export function primeOxideTuple(config: WebWalletConfig, tuple: OxideEnvTuple): void {
  cached = { key: cacheKey(config), tuple: Promise.resolve(tuple) }
}

/**
 * The oxide manifest tuple for the active profile, fetched once per profile —
 * `loadOxideManifestTuple` is a bare HTTP fetch, and the SIPA sync loop reads
 * the tuple every tick. A failed fetch is not sticky; the next call retries.
 */
export function getOxideTuple(config: WebWalletConfig): Promise<OxideEnvTuple> {
  const key = cacheKey(config)
  if (cached?.key !== key) {
    const tuple = loadOxideManifestTuple({ ...config.oxideProfile, network: config.network }).then(
      (loaded) => withRegistryController(config, loaded),
    )
    cached = { key, tuple }
    tuple.catch(() => {
      if (cached?.tuple === tuple) cached = undefined
    })
  }
  return cached.tuple
}

let retiredCached: { key: string; deployments: Promise<OxideEnvTuple[]> } | undefined

const portalTuples = new Map<string, Promise<OxideEnvTuple>>()

/** How long one manifest tuple fetch may take before a later read fetches again. */
export const ASSET_TUPLE_TIMEOUT_MS = 20_000

/**
 * The pinned deployment's retired-rollup siblings — other current deployments sharing its L1
 * chain and name registry, which is what sign-in admission needs to accept a passkey still bound
 * to a rollup this profile has since cut over from. A separate fetch and cache from
 * {@link getOxideTuple}'s (see {@link loadRetiredRollupSources}'s doc comment for why).
 * Bounded by {@link ASSET_TUPLE_TIMEOUT_MS}: a failed read stops sign-in from concluding a passkey
 * has no account, so a slow manifest must not fail it sooner than a portal tuple fetch. The bound
 * also keeps a fetch that never settles out of the cache.
 */
export async function getRetiredRollupSources(config: WebWalletConfig): Promise<OxideEnvTuple[]> {
  const key = cacheKey(config)
  if (retiredCached?.key !== key) {
    const deployments = withTimeout(
      loadRetiredRollupSources({ ...config.oxideProfile, network: config.network }),
      ASSET_TUPLE_TIMEOUT_MS,
    )
    retiredCached = { key, deployments }
    deployments.catch(() => {
      if (retiredCached?.deployments === deployments) retiredCached = undefined
    })
  }
  return retiredCached.deployments
}

/**
 * The manifest tuple of `portal` in the profile's manifest, fetched once per manifest and portal.
 * A failed or stalled fetch is not sticky: it rejects after {@link ASSET_TUPLE_TIMEOUT_MS} and the
 * next read fetches again.
 */
export function getPortalTuple(
  config: WebWalletConfig,
  portal: string,
  expectedGitSha?: string,
): Promise<OxideEnvTuple> {
  const key = `${config.oxideProfile.manifestUrl}|${portal.toLowerCase()}`
  let tuple = portalTuples.get(key)
  if (!tuple) {
    const made = withTimeout(
      loadOxideManifestTuple({
        manifestUrl: config.oxideProfile.manifestUrl,
        portal,
        ...(expectedGitSha ? { expectedGitSha } : {}),
        network: config.network,
      }),
      ASSET_TUPLE_TIMEOUT_MS,
    )
    portalTuples.set(key, made)
    made.catch(() => {
      if (portalTuples.get(key) === made) portalTuples.delete(key)
    })
    tuple = made
  }
  return tuple
}

/** The manifest tuple of the profile asset `symbol`; undefined where the profile lists no such asset. */
export function getAssetTuple(
  config: WebWalletConfig,
  symbol: string,
): Promise<OxideEnvTuple> | undefined {
  const asset = config.assets.find((candidate) => candidate.symbol === symbol)
  return asset && getPortalTuple(config, asset.portal, asset.expectedGitSha)
}

// TEMPORARY — remove once oxide's manifest carries registrationController. It is the one contract
// the NameRegistry points at that the manifest schema does not publish, so the registration
// schedule has nowhere else to look. The manifest value wins when present; a zero or failed read
// leaves the tuple as loaded.
const REGISTRY_CONTROLLER_ABI = parseAbi([
  "function registrationController() view returns (address)",
])

async function withRegistryController(
  config: WebWalletConfig,
  tuple: OxideEnvTuple,
): Promise<OxideEnvTuple> {
  if (
    (tuple.registrationController && !isAllZeroHex(tuple.registrationController)) ||
    !tuple.registry
  ) {
    return tuple
  }
  try {
    const controller = await l1PublicClient(config).readContract({
      address: tuple.registry as Address,
      abi: REGISTRY_CONTROLLER_ABI,
      functionName: "registrationController",
    })
    return isAllZeroHex(controller) ? tuple : { ...tuple, registrationController: controller }
  } catch (err) {
    console.warn(
      "registrationController read from the name registry failed; manifest tuple used as is",
      err,
    )
    return tuple
  }
}

/**
 * Read a manifest field a rail cannot run without — a thin manifest fails
 * here, naming the field, instead of as a TypeError deep in the flow.
 */
export function requireTupleField<K extends keyof OxideEnvTuple>(
  tuple: OxideEnvTuple,
  field: K,
): NonNullable<OxideEnvTuple[K]> {
  const value = tuple[field]
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    throw new Error(`oxide manifest lacks ${String(field)}`)
  }
  return value
}

/** One L1 public client over the configured chain + RPC. */
export function l1PublicClient(config: WebWalletConfig): PublicClient {
  return createPublicClient({
    chain: config.l1Chain,
    transport: l1Transport(config),
  }) as PublicClient
}

/** An L1 client that folds the contract reads it is handed within 50 ms into one Multicall3 call. */
export function l1MulticallClient(config: WebWalletConfig): PublicClient {
  const chain = {
    ...config.l1Chain,
    contracts: { ...config.l1Chain.contracts, multicall3: { address: MULTICALL3_ADDRESS } },
  }
  return createPublicClient({
    chain,
    transport: l1Transport(config),
    // viem's default 1 KiB of calldata per batch holds six predictSIPA reads.
    batch: { multicall: { wait: 50, batchSize: 16_384 } },
  }) as PublicClient
}

/**
 * The L2 address a registration asks oxide's NamePortal to report the claimed name to: this
 * deployment's ClaimFPC, whose registration rail consumes that message. It is committed into the
 * registration intent, so it is also part of the derived SIPA address — every path that re-derives
 * one (claim, sweep, seed, resume) reads it from here so they all reproduce the same address.
 *
 * A registration that named nobody would succeed and emit no message, leaving the rail permanently
 * closed to the account with nothing to show why, so an absent address fails the claim instead.
 */
function namePortalRecipient(config: WebWalletConfig): Hex {
  if (!config.claimFpcAddress) {
    throw new Error(
      "the config profile carries no claimFpc address — a registration would name no recipient " +
        "for the name message, and the sponsored rail would never admit this account",
    )
  }
  return config.claimFpcAddress as Hex
}

/** How long a resolver-operator selection is reused. Selecting one scans the deployment's whole
 *  operator log history, and the tag step starts it ahead of the claim. */
export const RESOLVER_OPERATOR_REUSE_MS = 5 * 60_000

type ResolverRecord = Awaited<ReturnType<typeof fetchSignupResolverRecord>>

let operatorCached:
  | { tuple: OxideEnvTuple; at: number; record: Promise<ResolverRecord> }
  | undefined

function signupResolverRecord(
  config: WebWalletConfig,
  tuple: OxideEnvTuple,
  publicClient: PublicClient,
): Promise<ResolverRecord> {
  if (
    operatorCached?.tuple !== tuple ||
    Date.now() - operatorCached.at > RESOLVER_OPERATOR_REUSE_MS
  ) {
    const record = fetchSignupResolverRecord(publicClient, tuple, config.network)
    operatorCached = { tuple, at: Date.now(), record }
    record.catch(() => {
      if (operatorCached?.record === record) operatorCached = undefined
    })
  }
  return operatorCached.record
}

/**
 * The resolved oxide env plus the L1 client it was read through — the preamble
 * every onboarding rail (claim, detection, recovery) builds.
 */
export async function oxideEnvFor(config: WebWalletConfig): Promise<{
  tuple: OxideEnvTuple
  env: ReturnType<typeof oxideEnvFromTuple>
  publicClient: PublicClient
  resolver: ResolverRecord
}> {
  const tuple = await getOxideTuple(config)
  const publicClient = l1PublicClient(config)
  const resolver = await signupResolverRecord(config, tuple, publicClient)
  const resolverOperator = resolver.owner as Address
  const accountFactory = resolveOxideAccountFactory({ tuple })
  const env = oxideEnvFromTuple(tuple, {
    resolverOperator,
    l1ChainId: config.l1ChainId,
    accountFactory,
    namePortalRecipient: namePortalRecipient(config),
  })
  return { tuple, env, publicClient, resolver }
}
