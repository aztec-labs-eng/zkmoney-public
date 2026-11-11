import { createPublicClient, parseAbi, type Address, type Hex, type PublicClient } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { isAllZeroHex } from "@obsidion/core/oxide"
import { MULTICALL3_ADDRESS } from "@obsidion/sdk"
import {
  deploymentScanRange,
  fetchSignupResolverRecord,
  oxideEnvFromTuple,
  resolveOxideAccountFactory,
} from "@obsidion/front-core"
import {
  oxideManifestDeployments,
  oxideManifestEntries,
  parseDeployment,
  pinnedEntryPolicy,
  type OxideDeployment,
} from "@obsidion/core/oxide"
import type { PageChain } from "../session/pageChain"
import { l1Transport, type WebWalletConfig } from "./env"

/** How long one manifest tuple fetch may take before a later read fetches again. */
export const ASSET_TUPLE_TIMEOUT_MS = 20_000

async function fetchManifest(manifestUrl: string): Promise<unknown> {
  const response = await fetch(manifestUrl)
  if (!response.ok) throw new Error(`oxide manifest HTTP ${response.status} (${manifestUrl})`)
  return response.json()
}

/** Every bridge `manifestUrl` lists. A malformed entry is skipped. */
export async function loadManifestBridges(manifestUrl: string): Promise<OxideEnvTuple[]> {
  return oxideManifestEntries(await fetchManifest(manifestUrl)).flatMap((entry) => {
    try {
      return [parseDeployment(entry).tuple]
    } catch {
      return []
    }
  })
}

/** Every deployment the profile's manifest lists. On mainnet one that fails the mainnet gate is left out. */
export async function loadManifestDeployments(config: WebWalletConfig): Promise<OxideDeployment[]> {
  return oxideManifestDeployments(
    await fetchManifest(config.oxideProfile.manifestUrl),
    pinnedEntryPolicy({ network: config.network }),
  )
}

/**
 * The first L1 block of the earliest deployment the manifest lists on `rollupVersion`: nothing a deployment on that
 * rollup sent is older, so a log scan about the rollup starts here. Undefined when the manifest cannot be read.
 * A deployment on the rollup that names no start block fails with `config.invalid`.
 */
export async function rollupScanFloor(
  reads: Pick<PageChain, "manifestDeployments">,
  publicClient: PublicClient,
  rollupVersion: string,
): Promise<bigint | undefined> {
  let read: [OxideDeployment[], bigint]
  try {
    read = await Promise.all([
      reads.manifestDeployments.read(),
      publicClient.getBlockNumber({ cacheTime: 0 }),
    ])
  } catch (error) {
    console.warn("[oxide] the rollup's first deployment block could not be read:", error)
    return undefined
  }
  const [deployments, head] = read
  const tuples = deployments
    .flatMap((deployment) => deployment.bridges.map((bridge) => bridge.tuple))
    .filter((tuple) => tuple.rollupVersion === rollupVersion)
  if (!tuples.length) return undefined
  const starts = await Promise.all(
    tuples.map(async (tuple) => (await deploymentScanRange(publicClient, tuple, head)).fromBlock),
  )
  return starts.reduce((low, start) => (start < low ? start : low))
}

/** The fleet a deployment's requests go to: the configured enclave override, else the manifest's router URL. */
export function fleetUrl(
  config: WebWalletConfig,
  tuple: Pick<OxideEnvTuple, "enclaveUrl">,
): string {
  return config.enclaveUrl ? `${config.enclaveUrl}/rpc` : tuple.enclaveUrl
}

// TEMPORARY — remove once oxide's manifest carries registrationController. It is the one contract
// the NameRegistry points at that the manifest schema does not publish, so the registration
// schedule has nowhere else to look. The manifest value wins when present; a zero or failed read
// leaves the tuple as loaded.
const REGISTRY_CONTROLLER_ABI = parseAbi([
  "function registrationController() view returns (address)",
])

export async function withRegistryController(
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

export type ResolverRecord = Awaited<ReturnType<typeof fetchSignupResolverRecord>>

/** The oxide env plus the L1 client it was read through: the preamble every onboarding rail (claim, detection,
 * recovery) builds. */
export function oxideEnvOf(
  config: WebWalletConfig,
  tuple: OxideEnvTuple,
  publicClient: PublicClient,
  resolver: ResolverRecord,
) {
  const env = oxideEnvFromTuple(tuple, {
    resolverOperator: resolver.owner as Address,
    l1ChainId: config.l1ChainId,
    accountFactory: resolveOxideAccountFactory({ tuple }),
    namePortalRecipient: namePortalRecipient(config),
  })
  return { tuple, env, publicClient, resolver }
}

export type OxideEnv = ReturnType<typeof oxideEnvOf>
