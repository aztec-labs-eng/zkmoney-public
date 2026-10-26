// Wallet-side profile boot: obtain the document (live; the build's baked snapshot when the server
// is unreachable or the consumer forces it), verify identity, resolve the version `current` names,
// compare the bundled zkJWT vkey hash.

import type { ContractServiceConfig, SourceArtifactManifest } from "@obsidion/core/types"
import {
  ConfigProfileError,
  type ConfigProfileErrorCode,
  type FetchProfileOptions,
  fetchConfigProfile,
  isExpired,
  parseServedProfile,
  retiredRollupVersion,
  retiredRollupVersions,
  resolveVersion,
  type RetiredRollupVersion,
} from "./client.js"
import type { ConfigProfile, ConfigVersion } from "./schema.js"
import { toContractServiceConfig } from "./toContractServiceConfig.js"

export type WalletProfileErrorCode =
  | "MISSING_CONFIG"
  | "IDENTITY_MISMATCH"
  | "NETWORK_MISMATCH"
  | "UNSUPPORTED_VERSION"

export class WalletProfileError extends Error {
  constructor(readonly code: WalletProfileErrorCode, message: string) {
    super(message)
    this.name = "WalletProfileError"
  }
}

export class ProfileNetworkMismatchError extends WalletProfileError {
  constructor(readonly profileNetwork: string, readonly activeNetwork: string, profileId: string) {
    super(
      "NETWORK_MISMATCH",
      `profile "${profileId}" is for network "${profileNetwork}" but this build is on "${activeNetwork}"`,
    )
    this.name = "ProfileNetworkMismatchError"
  }
}

export interface ResolveWalletProfileInput {
  profileUrl: string | undefined
  expectedProfileId: string | undefined
  /** The build's active network. `ProfileNetwork` values and the `Network` enum's values coincide. */
  network: string
  expectedZkJwtVkeyHash?: string
  expectedRollupVersion?: string
  /**
   * The document this build baked in. Consulted only when the live fetch fails as `UNREACHABLE`;
   * every other failure stays fatal, and the snapshot runs the same checks a served document does.
   */
  bakedProfile?: unknown
  /**
   * Boot from `bakedProfile` without fetching the active profile, and past the snapshot's own
   * expiry. Identity, network and version checks still run. For a consumer whose user has chosen
   * the shipped configuration over a profile nobody publishes anymore.
   */
  forceBakedProfile?: boolean
  fetchImpl?: typeof fetch
  now?: () => Date
  timeoutMs?: number
}

export interface WalletProfileBoot {
  profile: ConfigProfile
  versionId: string
  version: ConfigVersion
  snapshot: ContractServiceConfig
  nodeUrl: string
  /** Rollups named by embedded versions and previous-generation profiles. */
  sourceRollups: readonly WalletSourceRollup[]
  /** Historical references that could not supply a migration source. */
  sourceRollupIssues: readonly WalletSourceRollupIssue[]
  zkJwtVkeySkew: boolean
  /** `bakedProfile` booted the wallet: the live fetch was unreachable, or `forceBakedProfile` asked. */
  bootedFromBakedProfile: boolean
  /** The live failure a snapshot boot stood in for. Absent when the active fetch was skipped. */
  liveFailure?: { code: ConfigProfileErrorCode; message: string }
  /** A forced boot's snapshot has passed its `expiresAt`. */
  bakedProfileExpired?: boolean
}

export interface WalletSourceRollup extends RetiredRollupVersion {
  contracts: ContractServiceConfig
  /** A previous generation's artifact manifest; a version of the active generation shares its own. */
  artifacts?: SourceArtifactManifest
}

export interface WalletSourceRollupIssue {
  profileUrl: string
  code: ConfigProfileErrorCode | WalletProfileErrorCode | "UNKNOWN"
  message: string
}

/** What a consumer expects of the document it boots from. `source` names it in errors. */
export interface WalletProfileExpectations {
  source: string
  expectedProfileId: string
  network: string
  expectedZkJwtVkeyHash?: string
  expectedRollupVersion?: string
}

export type ResolvedWalletProfile = Omit<
  WalletProfileBoot,
  "bootedFromBakedProfile" | "liveFailure" | "bakedProfileExpired"
>

/**
 * Everything after "obtain the document": identity, network, rollup, the live version, the vkey
 * compare, the snapshot. Pure, so the live path, the baked path and a build-time check run one
 * rulebook.
 */
export function resolveWalletProfileDocument(
  profile: ConfigProfile,
  expect: WalletProfileExpectations,
): ResolvedWalletProfile {
  // Two mixup axes, two checks, both fatal. `profileId` asks "is this the document this build
  // was built against" — the URL is untrusted config and cannot vouch for itself, while the
  // expected id is baked in and can. It runs FIRST so a wrong document is named as such before
  // the narrower network question.
  if (profile.profileId !== expect.expectedProfileId) {
    throw new WalletProfileError(
      "IDENTITY_MISMATCH",
      `${expect.source} identifies as "${profile.profileId}" but this build expects ` +
        `"${expect.expectedProfileId}"`,
    )
  }
  if (profile.network !== expect.network) {
    throw new ProfileNetworkMismatchError(profile.network, expect.network, profile.profileId)
  }

  if (
    expect.expectedRollupVersion &&
    profile.shared.rollupVersion !== expect.expectedRollupVersion
  ) {
    throw new WalletProfileError(
      "UNSUPPORTED_VERSION",
      `profile "${profile.profileId}" is scoped to rollup ${profile.shared.rollupVersion}; this ` +
        `build speaks ${expect.expectedRollupVersion}. An app update is required before this ` +
        "profile can be adopted.",
    )
  }

  const { versionId, version } = resolveVersion(profile)

  return {
    profile,
    versionId,
    version,
    snapshot: toContractServiceConfig(profile),
    nodeUrl: version.nodeUrl,
    sourceRollups: retiredRollupVersions(profile).map((source) => ({
      ...source,
      contracts: toContractServiceConfig(profile, source.versionId),
    })),
    sourceRollupIssues: [],
    zkJwtVkeySkew: hasVkeySkew(version, expect.expectedZkJwtVkeyHash),
  }
}

interface PreviousGenerationOptions
  extends Pick<FetchProfileOptions, "fetchImpl" | "now" | "timeoutMs"> {
  network: string
  activeNodeUrl: string
}

const sourceRollupKey = (source: WalletSourceRollup) =>
  [
    source.nodeUrl,
    source.manifestUrl,
    ...source.pins.map((pin) => `${pin.portal.toLowerCase()}\n${pin.expectedGitSha ?? ""}`).sort(),
  ].join("\n")

function distinctSourceRollups(sources: readonly WalletSourceRollup[]): WalletSourceRollup[] {
  const found = new Map<string, WalletSourceRollup>()
  for (const source of sources) {
    const key = sourceRollupKey(source)
    if (!found.has(key)) found.set(key, source)
  }
  return [...found.values()]
}

/** Read previous generations without blocking active-profile boot. */
async function resolvePreviousGenerations(
  profile: ConfigProfile,
  options: PreviousGenerationOptions,
): Promise<{
  sourceRollups: WalletSourceRollup[]
  issues: WalletSourceRollupIssue[]
}> {
  let profileUrl = profile.shared.previousGenerationProfile
  const seen = new Set<string>()
  const sourceRollups: WalletSourceRollup[] = []
  const issues: WalletSourceRollupIssue[] = []
  while (profileUrl && !seen.has(profileUrl)) {
    const currentUrl = profileUrl
    seen.add(currentUrl)
    if (seen.size > 64) {
      issues.push({
        profileUrl: currentUrl,
        code: "INVALID_PROFILE",
        message: "previous-generation history exceeds 64 profiles",
      })
      break
    }

    try {
      const sourceProfile = await fetchConfigProfile(currentUrl, options)
      if (sourceProfile.network !== options.network) {
        throw new ProfileNetworkMismatchError(
          sourceProfile.network,
          options.network,
          sourceProfile.profileId,
        )
      }
      const source = resolveVersion(sourceProfile)
      const retired = retiredRollupVersion(source.versionId, source.version, options.activeNodeUrl)
      if (retired) {
        sourceRollups.push({
          ...retired,
          contracts: toContractServiceConfig(sourceProfile, source.versionId),
          artifacts: {
            profileUrl: currentUrl,
            profileId: sourceProfile.profileId,
            versionId: source.versionId,
            expectedSha256: source.version.artifactManifestSha256,
          },
        })
      }

      profileUrl = sourceProfile.shared.previousGenerationProfile
    } catch (error) {
      issues.push(sourceRollupIssue(currentUrl, error))
      break
    }
  }
  return { sourceRollups: distinctSourceRollups(sourceRollups), issues }
}

function sourceRollupIssue(profileUrl: string, error: unknown): WalletSourceRollupIssue {
  const code =
    error instanceof ConfigProfileError || error instanceof WalletProfileError
      ? error.code
      : "UNKNOWN"
  const message = error instanceof Error ? error.message : String(error)
  return { profileUrl, code, message }
}

async function withPreviousGenerations(
  resolved: ResolvedWalletProfile,
  input: ResolveWalletProfileInput,
): Promise<ResolvedWalletProfile> {
  const referenced = await resolvePreviousGenerations(resolved.profile, {
    network: input.network,
    activeNodeUrl: resolved.nodeUrl,
    fetchImpl: input.fetchImpl,
    now: input.now,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  })
  return {
    ...resolved,
    sourceRollups: distinctSourceRollups([...resolved.sourceRollups, ...referenced.sourceRollups]),
    sourceRollupIssues: referenced.issues,
  }
}

export async function resolveWalletProfile(
  input: ResolveWalletProfileInput,
): Promise<WalletProfileBoot> {
  const { profileUrl, expectedProfileId } = input
  if (!profileUrl) {
    throw new WalletProfileError(
      "MISSING_CONFIG",
      "a profile URL is required to boot in profile mode",
    )
  }
  if (!expectedProfileId) {
    throw new WalletProfileError(
      "MISSING_CONFIG",
      `an expected profile id is required whenever a profile URL is set (${profileUrl})`,
    )
  }

  const expectations: WalletProfileExpectations = {
    source: `profile at ${profileUrl}`,
    expectedProfileId,
    network: input.network,
    expectedZkJwtVkeyHash: input.expectedZkJwtVkeyHash,
    expectedRollupVersion: input.expectedRollupVersion,
  }

  const now = input.now ?? (() => new Date())
  if (input.forceBakedProfile) {
    if (input.bakedProfile === undefined) {
      throw new WalletProfileError(
        "MISSING_CONFIG",
        "the shipped configuration was requested but this build baked no profile",
      )
    }
    const baked = parseServedProfile(input.bakedProfile, { now, ignoreExpiry: true })
    const resolved = await withPreviousGenerations(
      resolveWalletProfileDocument(baked, { ...expectations, source: "the baked profile" }),
      input,
    )
    return {
      ...resolved,
      bootedFromBakedProfile: true,
      bakedProfileExpired: isExpired(baked, now()),
    }
  }

  let profile: ConfigProfile
  try {
    profile = await fetchConfigProfile(profileUrl, {
      fetchImpl: input.fetchImpl,
      now: input.now,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    })
  } catch (e) {
    const unreachable = e instanceof ConfigProfileError && e.code === "UNREACHABLE"
    if (!unreachable || input.bakedProfile === undefined) throw e
    const liveFailure = { code: e.code, message: e.message }
    try {
      const baked = parseServedProfile(input.bakedProfile, { now: input.now })
      const resolved = await withPreviousGenerations(
        resolveWalletProfileDocument(baked, {
          ...expectations,
          source: "the baked profile",
        }),
        input,
      )
      return { ...resolved, bootedFromBakedProfile: true, liveFailure }
    } catch (snapshotError) {
      throw withLiveFailure(snapshotError, e)
    }
  }

  const resolved = await withPreviousGenerations(
    resolveWalletProfileDocument(profile, expectations),
    input,
  )
  return { ...resolved, bootedFromBakedProfile: false }
}

/**
 * The retry screen shows one message, so the snapshot's own failure names the live one. The error
 * keeps its class and code; `message` is redefined rather than assigned, since some error types
 * expose it read-only, and the live failure also rides along as `cause`.
 */
function withLiveFailure(snapshotError: unknown, live: ConfigProfileError): unknown {
  if (!(snapshotError instanceof Error)) return snapshotError
  Object.defineProperty(snapshotError, "message", {
    value: `${snapshotError.message} (live profile unreachable: ${live.message})`,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(snapshotError, "cause", { value: live, configurable: true, writable: true })
  return snapshotError
}

function hasVkeySkew(version: ConfigVersion, expected: string | undefined): boolean {
  const served = version.vkeys?.zkJwtVkeyHash
  if (!served || !expected) return false
  return served.toLowerCase() !== expected.toLowerCase()
}
