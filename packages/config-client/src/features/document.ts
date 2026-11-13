import { z } from "zod"
import { fullGitSha, isoInstant, nonEmpty, profileId } from "../fields.js"
import { NETWORK_L1_CHAIN_IDS, PROFILE_NETWORKS, type ProfileNetwork } from "../schema.js"
import { withoutUnknownKeys } from "../wire.js"
import type {
  AnyFeatureDefinition,
  FeatureContext,
  FeatureIssue,
  FeatureRegistry,
  FeaturesOf,
  OxideRole,
} from "./define.js"
import { FEATURES } from "./registry.js"

/**
 * The wallet features built on top of the deployment one profile pins, served at
 * `features/<generation>/current.json` beside it. A feature never overrides a profile value.
 */

export const FEATURES_DOCUMENT_SCHEMA_VERSION = "1"

const FEATURE_ID = /^[a-z][a-zA-Z0-9]{0,63}$/

const envelopeFields = {
  profileId,
  network: z.enum(PROFILE_NETWORKS),
  /** Stamped at publish; the committed sources omit it. */
  publishedAt: isoInstant.optional(),
  /** Every feature is off once it has passed. */
  expiresAt: isoInstant.optional(),
  /** Commit the document was published from; stamped at publish. */
  gitSha: fullGitSha.optional(),
  features: z.record(z.string().regex(FEATURE_ID, "feature id: camelCase"), z.unknown()),
}
const strictEnvelope = z.strictObject({
  schemaVersion: z.literal(FEATURES_DOCUMENT_SCHEMA_VERSION),
  ...envelopeFields,
})
// Served: unknown envelope keys are dropped, and the marker is read before the shape.
const servedEnvelope = z.object({ schemaVersion: nonEmpty, ...envelopeFields })

type Envelope = Omit<z.infer<typeof strictEnvelope>, "features">

export type FeaturesDocument<R extends FeatureRegistry = typeof FEATURES> = Envelope & {
  features: FeaturesOf<R>
}

export type FeaturesDocumentErrorCode =
  | "UNREACHABLE"
  | "HTTP_ERROR"
  | "NOT_FOUND"
  | "INVALID_DOCUMENT"
  | "UNSUPPORTED_SCHEMA"
  | "IDENTITY_MISMATCH"
  | "EXPIRED"

/** Any of these turns every feature off; the core still boots. */
export class FeaturesDocumentError extends Error {
  constructor(readonly code: FeaturesDocumentErrorCode, message: string) {
    super(message)
    this.name = "FeaturesDocumentError"
  }
}

const formatIssues = (issues: FeatureIssue[]) =>
  issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")

const zodIssues = (error: z.ZodError, prefix: (string | number)[] = []): FeatureIssue[] =>
  error.issues.map((i) => ({
    message: i.message,
    path: [...prefix, ...(i.path as (string | number)[])],
  }))

function parsePart<S extends z.ZodType>(
  schema: S,
  data: unknown,
  tolerant: boolean,
): { value: z.infer<S> } | { error: z.ZodError } {
  const parsed = schema.safeParse(data)
  if (parsed.success) return { value: parsed.data }
  const pruned = tolerant ? withoutUnknownKeys(data, parsed.error) : undefined
  if (pruned === undefined) return { error: parsed.error }
  const retried = schema.safeParse(pruned)
  return retried.success ? { value: retried.data } : { error: retried.error }
}

/** Every network but sandbox serves real users, so every URL a feature names must be https. */
function insecureUrls(value: unknown, path: (string | number)[]): FeatureIssue[] {
  if (typeof value === "string")
    return /^http:\/\//i.test(value) ? [{ message: "must be https", path }] : []
  if (Array.isArray(value))
    return value.flatMap((item, index) => insecureUrls(item, [...path, index]))
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => insecureUrls(item, [...path, key]))
  return []
}

function parseEntry(
  definition: AnyFeatureDefinition,
  raw: unknown,
  context: FeatureContext,
  tolerant: boolean,
): { entry: unknown } | { issues: FeatureIssue[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { issues: [{ message: "expected an object", path: [] }] }
  const { oxide: bindings = {}, ...payloadData } = raw as Record<string, unknown>
  const roles = Object.entries<OxideRole>(definition.oxide ?? {})
  const bindingSchema = z.strictObject(
    Object.fromEntries(roles.map(([role]) => [role, nonEmpty.optional()])),
  )
  const issues: FeatureIssue[] = []
  const oxide = parsePart(bindingSchema, bindings, tolerant)
  if ("error" in oxide) issues.push(...zodIssues(oxide.error, ["oxide"]))
  else
    for (const [role, declared] of roles)
      if (!declared.optional && oxide.value[role] === undefined)
        issues.push({
          message: `binds no Oxide feature to the required role "${role}"`,
          path: ["oxide", role],
        })
  const payload = parsePart(definition.schema, payloadData, tolerant)
  if ("error" in payload) issues.push(...zodIssues(payload.error))
  else {
    issues.push(...(definition.check?.(payload.value, context) ?? []))
    if (context.network !== "sandbox") issues.push(...insecureUrls(payload.value, []))
  }
  if (issues.length || "error" in oxide || "error" in payload) return { issues }
  return { entry: { ...(payload.value as object), oxide: oxide.value } }
}

function contextFor(network: ProfileNetwork): FeatureContext {
  return { network, l1ChainId: NETWORK_L1_CHAIN_IDS[network] }
}

function envelopeIssues(envelope: Envelope): FeatureIssue[] {
  const { publishedAt, expiresAt } = envelope
  return publishedAt && expiresAt && Date.parse(expiresAt) <= Date.parse(publishedAt)
    ? [{ message: "expiresAt must be after publishedAt", path: ["expiresAt"] }]
    : []
}

/** Strict, for the authoring gates: every violation and every unknown feature id fails. */
export function parseFeaturesDocument<R extends FeatureRegistry = typeof FEATURES>(
  data: unknown,
  registry: R = FEATURES as unknown as R,
): FeaturesDocument<R> {
  const envelope = strictEnvelope.safeParse(data)
  if (!envelope.success)
    throw new FeaturesDocumentError("INVALID_DOCUMENT", formatIssues(zodIssues(envelope.error)))
  const { features: raw, ...rest } = envelope.data
  const issues = envelopeIssues(rest)
  const features: Record<string, unknown> = {}
  const context = contextFor(rest.network)
  for (const [id, value] of Object.entries(raw)) {
    const definition = registry.find((d) => d.id === id)
    if (!definition) {
      issues.push({ message: `unknown feature "${id}"`, path: ["features", id] })
      continue
    }
    const parsed = parseEntry(definition, value, context, false)
    if ("issues" in parsed)
      issues.push(...parsed.issues.map((i) => ({ ...i, path: ["features", id, ...i.path] })))
    else features[id] = parsed.entry
  }
  if (issues.length) throw new FeaturesDocumentError("INVALID_DOCUMENT", formatIssues(issues))
  return { ...rest, features: features as FeaturesOf<R> }
}

export interface RejectedFeature {
  id: string
  reason: string
}

export interface ServedFeatures<R extends FeatureRegistry = typeof FEATURES> {
  document: Envelope
  features: FeaturesOf<R>
  /** Features this build knows whose entries it could not read; each is off. */
  rejected: RejectedFeature[]
}

export interface ServedFeaturesOptions<R extends FeatureRegistry> {
  /** What the build was built against. */
  expected: { profileId: string; network: ProfileNetwork }
  now?: () => Date
  registry?: R
}

/**
 * The client's rulebook, for a fetched or baked document. A feature id this build does not know is
 * skipped, unknown keys are dropped, and an entry that still fails turns only that feature off.
 * Anything wrong with the envelope throws, and the caller runs with every feature off.
 */
export function parseServedFeatures<R extends FeatureRegistry = typeof FEATURES>(
  data: unknown,
  options: ServedFeaturesOptions<R>,
): ServedFeatures<R> {
  const registry = options.registry ?? (FEATURES as unknown as R)
  const now = options.now ?? (() => new Date())
  const marker = (data as { schemaVersion?: unknown } | null)?.schemaVersion
  if (typeof marker === "string" && marker !== FEATURES_DOCUMENT_SCHEMA_VERSION)
    throw new FeaturesDocumentError(
      "UNSUPPORTED_SCHEMA",
      `features document schema "${marker}"; this build reads "${FEATURES_DOCUMENT_SCHEMA_VERSION}"`,
    )
  const envelope = servedEnvelope.safeParse(data)
  if (!envelope.success)
    throw new FeaturesDocumentError("INVALID_DOCUMENT", formatIssues(zodIssues(envelope.error)))
  const { features: raw, schemaVersion: _, ...rest } = envelope.data
  const document: Envelope = { schemaVersion: FEATURES_DOCUMENT_SCHEMA_VERSION, ...rest }
  const invalid = envelopeIssues(document)
  if (invalid.length) throw new FeaturesDocumentError("INVALID_DOCUMENT", formatIssues(invalid))
  const { expected } = options
  if (document.profileId !== expected.profileId || document.network !== expected.network)
    throw new FeaturesDocumentError(
      "IDENTITY_MISMATCH",
      `features document is for ${document.profileId} on ${document.network}; this build expects ` +
        `${expected.profileId} on ${expected.network}`,
    )
  if (document.expiresAt && Date.parse(document.expiresAt) <= now().getTime())
    throw new FeaturesDocumentError("EXPIRED", `features document expired at ${document.expiresAt}`)

  const features: Record<string, unknown> = {}
  const rejected: RejectedFeature[] = []
  const context = contextFor(document.network)
  for (const [id, value] of Object.entries(raw)) {
    const definition = registry.find((d) => d.id === id)
    if (!definition) continue
    const parsed = parseEntry(definition, value, context, true)
    if ("issues" in parsed) rejected.push({ id, reason: formatIssues(parsed.issues) })
    else features[id] = parsed.entry
  }
  return { document, features: features as FeaturesOf<R>, rejected }
}
