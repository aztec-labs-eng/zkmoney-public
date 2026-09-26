import { createPublicClient, parseAbi, type Address, type Hex, type PublicClient } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { isAllZeroHex } from "@obsidion/core/oxide"
import {
  fetchSignupResolverOperator,
  loadOxideManifestTuple,
  oxideEnvFromTuple,
  resolveOxideAccountFactory,
} from "@obsidion/front-core"
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

/**
 * The resolved oxide env plus the L1 client it was read through — the preamble
 * every onboarding rail (claim, detection, recovery) builds.
 */
export async function oxideEnvFor(config: WebWalletConfig): Promise<{
  tuple: OxideEnvTuple
  env: ReturnType<typeof oxideEnvFromTuple>
  publicClient: PublicClient
}> {
  const tuple = await getOxideTuple(config)
  const publicClient = l1PublicClient(config)
  const resolverOperator = await fetchSignupResolverOperator(publicClient, tuple, config.network)
  const accountFactory = resolveOxideAccountFactory({ tuple })
  const env = oxideEnvFromTuple(tuple, {
    resolverOperator,
    l1ChainId: config.l1ChainId,
    accountFactory,
    namePortalRecipient: namePortalRecipient(config),
  })
  return { tuple, env, publicClient }
}
