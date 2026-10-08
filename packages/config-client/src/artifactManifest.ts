import { z } from "zod"

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = "1"
export const DEFAULT_ARTIFACT_MANIFEST_FETCH_TIMEOUT_MS = 15_000

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const VERSION_ID = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const CLASS_ID = /^0x[0-9a-fA-F]{64}$/
const LOWER_CLASS_ID = /^0x[0-9a-f]{64}$/
const SHA256 = /^[0-9a-f]{64}$/

/**
 * A blob is addressed by checksum; the client derives its URL from the profile URL. Manifests
 * published before 0.14.0 also name a `url`, accepted only when it equals that derivation.
 */
const artifactPinSchema = z.strictObject({
  url: z
    .url({ protocol: /^https$/ })
    .refine((value) => {
      const url = new URL(value)
      return !url.username && !url.password
    }, "artifact URL must not contain credentials")
    .optional(),
  sha256: z.string().regex(SHA256, "artifact sha256 must be lowercase hexadecimal"),
  encoding: z.literal("aztec-contract-artifact").optional(),
})

const artifactEntrySchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/),
  artifact: artifactPinSchema,
})

const artifactClassesSchema = z
  .record(z.string(), artifactEntrySchema)
  .superRefine((classes, ctx) => {
    const seen = new Set<string>()
    for (const key of Object.keys(classes)) {
      if (!CLASS_ID.test(key)) {
        ctx.addIssue({ code: "custom", message: "invalid Aztec class id", path: [key] })
        continue
      }
      const normalized = key.toLowerCase()
      if (seen.has(normalized)) {
        ctx.addIssue({ code: "custom", message: "duplicate Aztec class id", path: [key] })
      }
      seen.add(normalized)
    }
  })
  .transform((classes) =>
    Object.fromEntries(Object.entries(classes).map(([key, value]) => [key.toLowerCase(), value])),
  )

export const artifactManifestSchema = z.strictObject({
  schemaVersion: z.literal(ARTIFACT_MANIFEST_SCHEMA_VERSION),
  profileId: z.string().regex(PROFILE_ID),
  versionId: z.string().regex(VERSION_ID),
  classes: artifactClassesSchema,
})

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>
export type ArtifactManifestEntry = z.infer<typeof artifactEntrySchema>
export type ArtifactPin = z.infer<typeof artifactPinSchema>
/** A pin with its URL settled: what the class-artifact resolver fetches. */
export interface ResolvedArtifactPin {
  url: string
  sha256: string
  encoding?: "aztec-contract-artifact"
}

export class ArtifactManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArtifactManifestError"
  }
}

export function parseArtifactManifest(data: unknown): ArtifactManifest {
  const parsed = artifactManifestSchema.safeParse(data)
  if (!parsed.success) {
    throw new ArtifactManifestError(
      `artifact manifest schema violations:\n${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n")}`,
    )
  }
  return parsed.data
}

/** The store URL every artifact address derives from: `/profiles/<generation>/<current|x.y.z>.json`. */
function parseProfileUrl(profileUrl: string): { url: URL; generation: string; fileVersion: string } {
  let url: URL
  try {
    url = new URL(profileUrl)
  } catch {
    throw new ArtifactManifestError(`invalid profile URL: ${profileUrl}`)
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ArtifactManifestError(
      "artifact manifest derivation requires a plain HTTPS profile URL without credentials, query or fragment",
    )
  }
  const match =
    /^\/profiles\/(v[1-9]\d*)\/(current|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.json$/.exec(
      url.pathname,
    )
  if (!match) {
    throw new ArtifactManifestError(
      `profile URL must match /profiles/<generation>/<current|x.y.z>.json: ${profileUrl}`,
    )
  }
  const [, generation, fileVersion] = match
  return { url, generation: generation!, fileVersion: fileVersion! }
}

/** Throws unless artifact addresses can derive from this profile URL. */
export function assertProfileUrlShape(profileUrl: string): void {
  parseProfileUrl(profileUrl)
}

/** Map a fetched profile document to the immutable artifact manifest for its selected version. */
export function artifactManifestUrl(profileUrl: string, versionId: string): string {
  if (!VERSION_ID.test(versionId)) {
    throw new ArtifactManifestError(`artifact manifest version "${versionId}" must be x.y.z`)
  }
  const { url, generation, fileVersion } = parseProfileUrl(profileUrl)
  if (fileVersion !== "current" && fileVersion !== versionId) {
    throw new ArtifactManifestError(
      `profile URL pins version ${fileVersion} but artifact manifest resolution selected ${versionId}`,
    )
  }
  url.pathname = `/artifacts/${generation}/${versionId}.json`
  return url.toString()
}

/** The blob for one class checksum, beside the profile: `/artifacts/<generation>/<sha256>.json`. */
export function artifactBlobUrl(profileUrl: string, sha256: string): string {
  if (!SHA256.test(sha256)) {
    throw new ArtifactManifestError(`artifact blob checksum "${sha256}" must be lowercase SHA-256`)
  }
  const { url, generation } = parseProfileUrl(profileUrl)
  url.pathname = `/artifacts/${generation}/${sha256}.json`
  return url.toString()
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export interface FetchArtifactManifestInput {
  profileUrl: string
  profileId: string
  versionId: string
  expectedSha256: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function fetchArtifactManifest(
  input: FetchArtifactManifestInput,
): Promise<ArtifactManifest> {
  if (!SHA256.test(input.expectedSha256)) {
    throw new ArtifactManifestError("artifact manifest pin must be a lowercase SHA-256 value")
  }
  const url = artifactManifestUrl(input.profileUrl, input.versionId)
  const controller = new AbortController()
  const timeoutMs = input.timeoutMs ?? DEFAULT_ARTIFACT_MANIFEST_FETCH_TIMEOUT_MS
  const expiry = setTimeout(() => controller.abort(), timeoutMs)
  let bytes: ArrayBuffer
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    })
    if (!response.ok) {
      throw new ArtifactManifestError(
        `artifact manifest fetch returned ${response.status} for ${url}`,
      )
    }
    bytes = await response.arrayBuffer()
  } catch (error) {
    if (error instanceof ArtifactManifestError) throw error
    const reason = controller.signal.aborted
      ? `no complete response within ${timeoutMs}ms`
      : (error as Error).message
    throw new ArtifactManifestError(`artifact manifest fetch failed: ${reason}`)
  } finally {
    clearTimeout(expiry)
  }

  const actualSha256 = await sha256Hex(bytes)
  if (actualSha256 !== input.expectedSha256) {
    throw new ArtifactManifestError(
      `artifact manifest checksum differs: expected ${input.expectedSha256}, got ${actualSha256}`,
    )
  }

  let data: unknown
  try {
    data = JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new ArtifactManifestError(`artifact manifest is not JSON: ${(error as Error).message}`)
  }
  const manifest = parseArtifactManifest(data)
  if (manifest.profileId !== input.profileId) {
    throw new ArtifactManifestError(
      `artifact manifest identifies as "${manifest.profileId}" but the profile is "${input.profileId}"`,
    )
  }
  if (manifest.versionId !== input.versionId) {
    throw new ArtifactManifestError(
      `artifact manifest is for version ${manifest.versionId} but the profile selected ${input.versionId}`,
    )
  }
  return manifest
}

export interface ArtifactPinResolverInput {
  profileUrl: string
  profileId: string
  versionId: string
  expectedSha256?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** Lazily fetch one manifest and resolve its class pins; a failed fetch remains retryable. */
export function createArtifactPinResolver(input: ArtifactPinResolverInput) {
  let manifestPromise: Promise<ArtifactManifest> | undefined
  return async (classId: string): Promise<ResolvedArtifactPin> => {
    if (!LOWER_CLASS_ID.test(classId)) {
      throw new ArtifactManifestError(`invalid historical class id: ${classId}`)
    }
    if (!input.expectedSha256) {
      throw new ArtifactManifestError(
        `profile "${input.profileId}" version ${input.versionId} has no artifact manifest pin`,
      )
    }
    if (!manifestPromise) {
      manifestPromise = fetchArtifactManifest({
        ...input,
        expectedSha256: input.expectedSha256,
      }).catch((error) => {
        manifestPromise = undefined
        throw error
      })
    }
    const manifest = await manifestPromise
    const entry = manifest.classes[classId]
    if (!entry) throw new ArtifactManifestError(`No reviewed artifact for class ${classId}`)
    const { sha256, url: named, encoding } = entry.artifact
    const url = artifactBlobUrl(input.profileUrl, sha256)
    if (named !== undefined && named !== url) {
      throw new ArtifactManifestError(
        `artifact for class ${classId} names ${named}, but the profile's store serves it at ${url}`,
      )
    }
    return { url, sha256, ...(encoding && { encoding }) }
  }
}
