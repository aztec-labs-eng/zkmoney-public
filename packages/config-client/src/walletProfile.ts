// Wallet-side profile boot: obtain the document (live, or the build's baked snapshot when the
// server is unreachable), verify identity, resolve the version `current` names, compare the
// bundled zkJWT vkey hash.

import type { ContractServiceConfig } from "@obsidion/core/types"
import {
  ConfigProfileError,
  type ConfigProfileErrorCode,
  fetchConfigProfile,
  parseServedProfile,
  resolveVersion,
} from "./client.js"
import type { ConfigProfile, ConfigVersion } from "./schema.js"
import { toContractServiceConfig } from "./toContractServiceConfig.js"

export type WalletProfileErrorCode =
  | "MISSING_CONFIG"
  | "IDENTITY_MISMATCH"
  | "NETWORK_MISMATCH"
  | "UNSUPPORTED_VERSION"

export class WalletProfileError extends Error {
  constructor(
    readonly code: WalletProfileErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "WalletProfileError"
  }
}

export class ProfileNetworkMismatchError extends WalletProfileError {
  constructor(
    readonly profileNetwork: string,
    readonly activeNetwork: string,
    profileId: string,
  ) {
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
  zkJwtVkeySkew: boolean
  /** The live fetch was unreachable and `bakedProfile` booted the wallet. */
  bootedFromBakedProfile: boolean
  /** The live failure a snapshot boot stood in for. */
  liveFailure?: { code: ConfigProfileErrorCode; message: string }
}

/** What a consumer expects of the document it boots from. `source` names it in errors. */
export interface WalletProfileExpectations {
  source: string
  expectedProfileId: string
  network: string
  expectedZkJwtVkeyHash?: string
  expectedRollupVersion?: string
}

export type ResolvedWalletProfile = Omit<WalletProfileBoot, "bootedFromBakedProfile" | "liveFailure">

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

  if (expect.expectedRollupVersion && profile.shared.rollupVersion !== expect.expectedRollupVersion) {
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
    zkJwtVkeySkew: hasVkeySkew(version, expect.expectedZkJwtVkeyHash),
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
      const resolved = resolveWalletProfileDocument(baked, {
        ...expectations,
        source: "the baked profile",
      })
      return { ...resolved, bootedFromBakedProfile: true, liveFailure }
    } catch (snapshotError) {
      throw withLiveFailure(snapshotError, e)
    }
  }

  return { ...resolveWalletProfileDocument(profile, expectations), bootedFromBakedProfile: false }
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
