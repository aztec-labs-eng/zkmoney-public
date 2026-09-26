import { z } from "zod"
import {
  type ConfigProfile,
  type ConfigVersion,
  VERSION_ENTRY_SCHEMA_VERSION,
  formatProfileIssues,
  isConfigVersionId,
  isSupportedVersion,
  isVersionSchemaMarker,
  parseConfigProfile,
} from "./schema.js"

/**
 * A consumer's baked config shrinks to {profileUrl, version?}. Every failure is typed and fatal —
 * a client that cannot resolve its profile says so at boot rather than degrading to stale config.
 * One code is set apart: `UNREACHABLE` means the server never answered, and it is the only failure
 * a consumer may cover with a document it baked in at build time. An answer — any 4xx — never
 * falls back, because this store answers a missing key with 403.
 */

export type ConfigProfileErrorCode =
  | "UNREACHABLE"
  | "HTTP_ERROR"
  | "NOT_FOUND"
  | "INVALID_PROFILE"
  | "INVALID_VERSION"
  | "EXPIRED"
  | "VERSION_NOT_FOUND"
  | "UNSUPPORTED_VERSION_SCHEMA"

export class ConfigProfileError extends Error {
  constructor(readonly code: ConfigProfileErrorCode, message: string) {
    super(message)
    this.name = "ConfigProfileError"
  }
}

export interface FetchProfileOptions {
  fetchImpl?: typeof fetch
  now?: () => Date
  /** Bounds the fetch. A wallet blocked on a hung connection has no way forward. */
  timeoutMs?: number
}

/** Long enough for a cold CDN edge on a slow phone; short enough that a hang reaches the retry UI. */
export const DEFAULT_PROFILE_FETCH_TIMEOUT_MS = 15_000

/** Drop only the keys a `strictObject` rejected (paths from zod); every other issue still fails. */
type UnrecognizedKeys = Extract<z.ZodError["issues"][number], { code: "unrecognized_keys" }>

const isUnrecognizedKeys = (issue: z.ZodError["issues"][number]): issue is UnrecognizedKeys =>
  issue.code === "unrecognized_keys"

function withoutUnknownKeys(data: unknown, error: z.ZodError): unknown | undefined {
  if (!error.issues.every(isUnrecognizedKeys)) return undefined
  const pruned = structuredClone(data)
  for (const issue of error.issues.filter(isUnrecognizedKeys)) {
    let target = pruned as Record<string, unknown> | undefined
    for (const step of issue.path) {
      target = target?.[step as string] as Record<string, unknown> | undefined
    }
    if (!target) continue
    for (const key of issue.keys) delete target[key]
  }
  return pruned
}

/**
 * Unknown keys are pruned and the document re-parsed, so a published field addition cannot brick
 * binaries that cannot update; every other violation stays fatal. `parseConfigProfile` stays
 * strict for the authoring gates.
 */
function parseWireProfile(data: unknown): ConfigProfile {
  try {
    return parseConfigProfile(data)
  } catch (e) {
    if (!(e instanceof z.ZodError)) throw e
    const pruned = withoutUnknownKeys(data, e)
    if (pruned === undefined) throw e
    return parseConfigProfile(pruned)
  }
}

/** A 4xx is the server answering; every other non-OK status (5xx, 0, out of range) is silence. */
const isClientError = (status: number) => status >= 400 && status <= 499

/**
 * The acceptance rulebook for a document however it arrived — fetched, or baked into a bundle at
 * build time: the wire-tolerant parse, then expiry against the caller's clock.
 */
export function parseServedProfile(
  data: unknown,
  options: { now?: () => Date } = {},
): ConfigProfile {
  const now = options.now ?? (() => new Date())
  let profile: ConfigProfile
  try {
    profile = parseWireProfile(data)
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new ConfigProfileError(
        "INVALID_PROFILE",
        `schema violations:\n${formatProfileIssues(e)}`,
      )
    }
    throw e
  }
  if (profile.expiresAt && Date.parse(profile.expiresAt) <= now().getTime()) {
    throw new ConfigProfileError(
      "EXPIRED",
      `profile "${profile.profileId}" expired at ${profile.expiresAt}`,
    )
  }
  return profile
}

export async function fetchConfigProfile(
  profileUrl: string,
  options: FetchProfileOptions = {},
): Promise<ConfigProfile> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => new Date())
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROFILE_FETCH_TIMEOUT_MS

  // The deadline covers the BODY too: headers-then-stall is the same hang, and aborting rejects
  // a pending `json()` like a pending fetch.
  const controller = new AbortController()
  const expiry = setTimeout(() => controller.abort(), timeoutMs)
  const timedOut = (e: unknown) =>
    controller.signal.aborted ? `no complete response within ${timeoutMs}ms` : (e as Error).message

  let data: unknown
  try {
    const response = await fetchImpl(profileUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
    // A 404 is fatal by design: a torn-down profile must not degrade to cached config.
    if (response.status === 404) {
      throw new ConfigProfileError("NOT_FOUND", `profile not found at ${profileUrl}`)
    }
    if (!response.ok) {
      throw new ConfigProfileError(
        isClientError(response.status) ? "HTTP_ERROR" : "UNREACHABLE",
        `profile fetch returned ${response.status} for ${profileUrl}`,
      )
    }
    try {
      data = await response.json()
    } catch (e) {
      // Abort is checked first: a body cut off by the deadline can surface as a SyntaxError.
      // Only a fully received body that is not JSON is invalid; a terminated stream is unreachable.
      if (controller.signal.aborted || !(e instanceof SyntaxError)) throw e
      throw new ConfigProfileError("INVALID_PROFILE", `profile is not JSON: ${e.message}`)
    }
  } catch (e) {
    if (e instanceof ConfigProfileError) throw e
    throw new ConfigProfileError("UNREACHABLE", `profile fetch failed: ${timedOut(e)}`)
  } finally {
    clearTimeout(expiry)
  }

  return parseServedProfile(data, { now })
}

export interface ResolvedVersion {
  versionId: string
  version: ConfigVersion
}

function assertVersionId(versionId: string): void {
  if (!isConfigVersionId(versionId)) {
    throw new ConfigProfileError(
      "INVALID_VERSION",
      `version override "${versionId}" must be x.y.z without leading zeros`,
    )
  }
}

/**
 * A cutover is an appended entry plus a moved pointer, picked up next boot; an override pins
 * (and reaches a published-but-not-yet-current version). An unknown-schema entry is refused
 * HERE, typed "app update required" — resolution is where an entry becomes config acted on.
 */
export function resolveVersion(
  profile: ConfigProfile,
  versionIdOverride?: string,
): ResolvedVersion {
  if (versionIdOverride !== undefined) assertVersionId(versionIdOverride)
  const versionId = versionIdOverride ?? profile.current
  // Own keys only; NOT_FOUND means absent — a junk-filled present slot classifies below.
  if (!Object.hasOwn(profile.versions, versionId)) {
    throw new ConfigProfileError(
      "VERSION_NOT_FOUND",
      `version "${versionId}" is not in profile "${profile.profileId}" (${Object.keys(
        profile.versions,
      ).join(", ")})`,
    )
  }
  const version = profile.versions[versionId]
  if (!isSupportedVersion(version)) {
    // The guard is full validation, so this branch classifies WHY: a well-formed unknown marker
    // is the app-update case; anything else is just invalid.
    const marker = (version as { schemaVersion?: unknown } | null | undefined)?.schemaVersion
    if (isVersionSchemaMarker(marker) && marker !== VERSION_ENTRY_SCHEMA_VERSION) {
      throw new ConfigProfileError(
        "UNSUPPORTED_VERSION_SCHEMA",
        `version "${versionId}" of profile "${profile.profileId}" is entry schema ` +
          `"${marker}"; this build reads "${VERSION_ENTRY_SCHEMA_VERSION}" — an app update is ` +
          "required before it can be used",
      )
    }
    throw new ConfigProfileError(
      "INVALID_PROFILE",
      `version "${versionId}" of profile "${profile.profileId}" is not a valid entry of schema ` +
        `"${VERSION_ENTRY_SCHEMA_VERSION}"`,
    )
  }
  return { versionId, version }
}

/**
 * The store lays every version out beside `current.json` — `profiles/<generation>/<x.y.z>.json` — so a
 * pin is the sibling document, not a key inside the one `profileUrl` names. No pin, no change.
 */
export function pinnedProfileUrl(profileUrl: string, versionId?: string): string {
  if (versionId === undefined) return profileUrl
  assertVersionId(versionId)
  const url = new URL(profileUrl)
  if (!url.pathname.endsWith("/current.json")) return profileUrl
  url.pathname = url.pathname.replace(/current\.json$/, `${versionId}.json`)
  return url.toString()
}
