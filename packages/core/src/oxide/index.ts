// Dependency-free validation, extraction and acquisition for oxide's hosted deployment-env
// manifest (schema v4: one self-contained `Deployment` entry per portal). Lives in the leaf
// package so every consumer shares one canonical path with zero `@aztec/*` runtime weight:
//   - `@obsidion/contracts` OxideEnvRegistryClient (the runtime tuple client)
//   - front-core's compatibility export (wallet-side fetch seam)
//   - account-service's loader (backend-side; cannot take front-core's weight)
//
// The pinned entry carries the ATOMIC attestation triple `enclaveUrl` ↔ `portal` ↔ `pcr0`
// (the enclave is verified against the on-chain portal binding), so consumers never mix that
// triple across entries. Every other entry on the same rollup and underlying (migrationSources
// plus the caller's UNDERLYING read) identifies a deployment a user may still hold funds on AND
// supplies the enclave the migration burn is co-signed against.

import { MAINNET_ENS_DOMAIN, MAINNET_ENTRY_POINT, Network } from "../constants/index.js"
import type { OxideEnvProfile, OxideEnvTuple } from "../types/index.js"

export { L1RpcSimulationUnsupportedError, assertL1RpcSimulates } from "./l1RpcSimulation.js"

// L1 (EVM) addresses are 20 bytes; L2 (Aztec field) addresses are 32 bytes.
const L1_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const L2_ADDRESS = /^0x[0-9a-fA-F]{64}$/

/** Validation failure ⇒ `manifest-incompatible` (vs network `fetch-failed`). */
export class OxideManifestValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new OxideManifestValidationError(
      `oxide env registry: ${field} is missing or malformed (got ${JSON.stringify(value)})`,
    )
  }
  return value
}

/** True for `0x0`, `0x00…0` — any all-zero hex string. */
export function isAllZeroHex(value: string): boolean {
  return /^0x0+$/i.test(value)
}

/** L1 address that is well-formed AND not the zero address (a zero address is truthy). */
export function requireNonZeroL1Address(value: unknown, field: string): string {
  const v = requirePattern(value, L1_ADDRESS, field)
  if (isAllZeroHex(v))
    throw new OxideManifestValidationError(`oxide env registry: ${field} is the zero address`)
  return v
}

/** L2 address that is well-formed AND not the zero address. */
export function requireNonZeroL2Address(value: unknown, field: string): string {
  const v = requirePattern(value, L2_ADDRESS, field)
  if (isAllZeroHex(v))
    throw new OxideManifestValidationError(`oxide env registry: ${field} is the zero address`)
  return v
}

function requireHttpUrl(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new OxideManifestValidationError(`oxide env registry: ${field} is not a string`)
  }
  try {
    const { protocol } = new URL(value)
    if (protocol !== "https:" && protocol !== "http:") throw new Error()
  } catch {
    throw new OxideManifestValidationError(
      `oxide env registry: ${field} is not a well-formed http(s) URL (got ${JSON.stringify(
        value,
      )})`,
    )
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** An ISO-8601 instant, kept verbatim alongside its epoch ms. Both callers bound something by it. */
function requireIsoTimestamp(value: unknown, field: string): { iso: string; ms: number } {
  const iso = requirePattern(value, /^\d{4}-\d{2}-\d{2}T/, field)
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new OxideManifestValidationError(
      `oxide env registry: ${field} is not parseable (got ${JSON.stringify(iso)})`,
    )
  }
  return { iso, ms }
}

/** A non-negative integer as a decimal string; anything else reads as absent. */
function optionalDecimal(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value)
  return typeof value === "string" && /^\d+$/.test(value) ? value : undefined
}

export interface ExtractOxideEnvTupleOptions {
  /**
   * Enforce the strict mainnet (`prod.v4.json`) schema: the a1/SIPA/fee address
   * surface present as well-formed NON-ZERO addresses and a numeric
   * `rollupVersion`. `accountFactory`/`entryPoint`/`ensDomain` are NOT required
   * here — the app hardcodes entryPoint/ensDomain, and the factory (oxide's on
   * every network) is demanded non-zero by its consumers, not by the parser.
   * Off for testnet/staging/dev/sandbox, which tolerate the leaner tuple.
   */
  requireProdSchema?: boolean
  /**
   * When set, the manifest's `gitSha` MUST equal this or extraction throws —
   * mainnet enforces same-sha parity fatally (vs the non-blocking drift WARN
   * OxideEnvRegistryClient emits for testnet/staging).
   */
  expectedGitSha?: string
}

/**
 * The policy every read of the pinned (canonical) entry applies: on MAINNET the full prod schema
 * and the same-sha gate against `expectedGitSha`; elsewhere a bare extract. Historic entries are
 * never held to the pinned entry's sha.
 */
export function pinnedEntryPolicy(pin: {
  network: Network
  expectedGitSha?: string
}): ExtractOxideEnvTupleOptions | undefined {
  return pin.network === Network.MAINNET
    ? { requireProdSchema: true, expectedGitSha: pin.expectedGitSha }
    : undefined
}

/**
 * Apply the strict mainnet gate to an already-extracted tuple. Split out from
 * extractPinnedOxideEnvTuple so a caller holding a tuple it did not parse itself runs
 * the exact same checks, and no unvetted tuple can go live on mainnet.
 */
export function assertProdOxideTuple(
  tuple: OxideEnvTuple,
  opts: ExtractOxideEnvTupleOptions,
): void {
  if (opts.requireProdSchema) {
    if (!/^\d+$/.test(tuple.rollupVersion ?? "")) {
      throw new OxideManifestValidationError(
        `oxide env registry: mainnet manifest has a missing or non-numeric rollupVersion ` +
          `(got ${JSON.stringify(tuple.rollupVersion)})`,
      )
    }
    // a1 / tag resolution reads registry; SIPA wiring reads resolverGatewayUrl / l2Broadcaster;
    // withdrawals settle into plainWithdrawalExecutor; token/portal/l2Token are the base tuple. All
    // must be well-formed and non-zero on mainnet.
    //
    // The deposit fee is NOT gated here. It is an immutable on the intent implementation the
    // `sipaFactory` serves, and the live mainnet document publishes no `sipaFactory` — gating it
    // would reject prod.json rather than describe it. A mainnet manifest without one has no
    // priceable SIPA rail at all, which the deposit reads report where they run.
    requireNonZeroL1Address(tuple.registry, "registry")
    requireNonZeroL1Address(tuple.plainWithdrawalExecutor, "plainWithdrawalExecutor")
    requireNonZeroL2Address(tuple.l2Broadcaster, "l2Broadcaster")
    requireHttpUrl(tuple.resolverGatewayUrl, "resolverGatewayUrl")
    requireNonZeroL1Address(tuple.token, "token")
    requireNonZeroL1Address(tuple.portal, "portal")
    requireNonZeroL2Address(tuple.l2Token, "l2Token")
    // Optional — a manifest without the swap stack simply offers no swap routes. A PUBLISHED
    // placeholder is the dangerous case: the burn pays a CREATE2 escrow derived from this factory,
    // and nothing can ever deploy at an address derived from zero.
    if (tuple.swapEscrowFactory !== undefined) {
      requireNonZeroL1Address(tuple.swapEscrowFactory, "swapEscrowFactory")
    }
  }
  if (opts.expectedGitSha && tuple.gitSha !== opts.expectedGitSha) {
    throw new OxideManifestValidationError(
      `oxide env registry: mainnet manifest gitSha ${JSON.stringify(tuple.gitSha)} != expected ` +
        `${JSON.stringify(opts.expectedGitSha)} — same-sha parity is enforced on mainnet.`,
    )
  }
}

/** Manifest v4: `{ schemaVersion: "4", deployments: [Deployment…] }`, one self-contained entry per portal. */
function requireDeployments(manifest: unknown): Record<string, unknown>[] {
  if (!isRecord(manifest)) {
    throw new OxideManifestValidationError("oxide env registry: manifest is not an object")
  }
  if (manifest.schemaVersion !== "4") {
    throw new OxideManifestValidationError(
      `oxide env registry: unsupported schemaVersion ${JSON.stringify(
        manifest.schemaVersion,
      )} (expected "4")`,
    )
  }
  if (!Array.isArray(manifest.deployments)) {
    throw new OxideManifestValidationError("oxide env registry: missing deployments array")
  }
  const deployments = manifest.deployments.map((entry, i) => {
    if (!isRecord(entry)) {
      throw new OxideManifestValidationError(
        `oxide env registry: deployments[${i}] is not an object`,
      )
    }
    return entry
  })
  requireUniqueDeployments(deployments)
  return deployments
}

function requireUniqueDeployments(deployments: Record<string, unknown>[]): void {
  const seen = { portal: new Map<string, number>(), label: new Map<string, number>() }
  deployments.forEach((entry, i) => {
    for (const key of ["portal", "label"] as const) {
      const value = entry[key]
      if (typeof value !== "string") continue
      const id = key === "portal" ? value.toLowerCase() : value
      const first = seen[key].get(id)
      if (first !== undefined) {
        throw new OxideManifestValidationError(
          `oxide env registry: deployments[${first}] and deployments[${i}] share ${key} ${value}`,
        )
      }
      seen[key].set(id, i)
    }
  })
}

function samePortal(entry: Record<string, unknown>, portal: string): boolean {
  return typeof entry.portal === "string" && entry.portal.toLowerCase() === portal.toLowerCase()
}

/** The v4 entry pinned by portal. Absent ⇒ throws naming the pin and every available portal. */
export function selectDeployment(
  manifest: unknown,
  pin: { portal: string },
): Record<string, unknown> {
  const deployments = requireDeployments(manifest)
  const hit = deployments.find((entry) => samePortal(entry, pin.portal))
  if (!hit) {
    const available = deployments.map((entry) => String(entry.portal)).join(", ") || "none"
    throw new OxideManifestValidationError(
      `oxide env registry: no deployment for pinned portal ${pin.portal} (available: ${available}) ` +
        "— profile fix or app update may be required",
    )
  }
  return hit
}

/**
 * One v4 entry → OxideEnvTuple, field for field. `timestamp` is the entry's `updatedAt` and moves
 * on every republish; `deployedAt` is when the deployment came into existence and does not.
 */
export function parseDeployment(entry: Record<string, unknown>): {
  tuple: OxideEnvTuple
  timestampMs: number
} {
  const { iso: updatedAt, ms: timestampMs } = requireIsoTimestamp(entry.updatedAt, "updatedAt")
  const tuple: OxideEnvTuple = {
    version: requirePattern(entry.label, /\S/, "label"),
    gitSha: optionalString(entry.gitSha) ?? "",
    timestamp: updatedAt,
    deployedAt: requireIsoTimestamp(entry.deployedAt, "deployedAt").iso,
    deployedAtBlock: optionalDecimal(entry.deployedAtBlock),
    portal: requirePattern(entry.portal, L1_ADDRESS, "portal"),
    token: requirePattern(entry.token, L1_ADDRESS, "token"),
    l2Token: requirePattern(entry.l2Token, L2_ADDRESS, "l2Token"),
    enclaveUrl: requireHttpUrl(entry.enclaveUrl, "enclaveUrl"),
    pcr0: optionalString(entry.pcr0) ?? "",
    rollupVersion: requirePattern(entry.rollupVersion, /^\d+$/, "rollupVersion"),
    chainId: requirePattern(entry.chainId, /^[1-9]\d*$/, "chainId"),
    certManager: optionalString(entry.certManager),
    nitroValidator: optionalString(entry.nitroValidator),
    registry: optionalString(entry.nameRegistry),
    accountMetadataRegistry: optionalString(entry.accountMetadataRegistry),
    accountFactory: optionalString(entry.accountFactory),
    registrationController: optionalString(entry.registrationController),
    namePortal: optionalString(entry.namePortal),
    paymaster: optionalString(entry.paymaster),
    entryPoint: optionalString(entry.entryPoint),
    ensDomain: optionalString(entry.ensDomain),
    sipaFactory: optionalString(entry.sipaFactory),
    sipaRecoveryProtocol: sipaRecoveryProtocol(entry.sipaRecoveryProtocol),
    sipaResolver: optionalString(entry.sipaResolver),
    resolverProofVerifier: optionalString(entry.resolverProofVerifier),
    resolverGatewayUrl: optionalString(entry.resolverGatewayUrl),
    depositSIPAImplementation: optionalString(entry.depositSIPAImplementation),
    registrationSIPAImplementation: optionalString(entry.registrationSIPAImplementation),
    depositSubsidy: optionalString(entry.depositSubsidy),
    withdrawalSubsidy: optionalString(entry.withdrawalSubsidy),
    proverSubsidy: optionalString(entry.proverSubsidy),
    plainWithdrawalExecutor: optionalString(entry.plainWithdrawalExecutor),
    l2Broadcaster: optionalString(entry.l2Broadcaster),
    frozenNotesRefundVerifier: optionalString(entry.frozenNotesRefundVerifier),
    frozenDepositRefundVerifier: optionalString(entry.frozenDepositRefundVerifier),
    unprocessedDepositRefundVerifier: optionalString(entry.unprocessedDepositRefundVerifier),
    frozenNotesRefundVkSha256: optionalString(entry.frozenNotesRefundVkSha256),
    frozenDepositRefundVkSha256: optionalString(entry.frozenDepositRefundVkSha256),
    swapEscrowFactory: optionalString(entry.swapEscrowFactory),
    operationExecutor: optionalString(entry.operationExecutor),
    fpcFunder: optionalString(entry.fpcFunder),
    fpcBeneficiary: optionalString(entry.fpcBeneficiary),
    fpcBeneficiarySalt: optionalString(entry.fpcBeneficiarySalt),
  }
  return { tuple: Object.freeze(tuple), timestampMs }
}

function sipaRecoveryProtocol(value: unknown): "legacy-eoa" | "account" {
  if (value === undefined || value === "legacy-eoa") return "legacy-eoa"
  if (value === "account") return "account"
  throw new Error("Unknown SIPA recovery protocol")
}

/**
 * Whether an entry speaks the withdraw-and-execute protocol this wallet builds against. Entries published before it
 * carry no `plainWithdrawalExecutor`; the wallet cannot burn on their tokens.
 */
function isCurrentProtocol(entry: Record<string, unknown>): boolean {
  return entry.plainWithdrawalExecutor !== undefined
}

/**
 * Every other current-protocol entry on the pinned deployment's rollup. Entries share the manifest's `token` even when
 * their portal escrows another asset, so the caller must still drop portals whose UNDERLYING differs from the pin's.
 * A malformed entry throws.
 */
export function migrationSources(manifest: unknown, pinned: OxideEnvTuple): OxideEnvTuple[] {
  return requireDeployments(manifest)
    .filter((entry) => !samePortal(entry, pinned.portal) && isCurrentProtocol(entry))
    .map((entry) => parseDeployment(entry).tuple)
    .filter((tuple) => tuple.rollupVersion === pinned.rollupVersion)
}

/** The pinned entry as a tuple, with the mainnet gate applied when `opts` says so. */
export function extractPinnedOxideEnvTuple(
  manifest: unknown,
  profile: Pick<OxideEnvProfile, "portal">,
  opts?: ExtractOxideEnvTupleOptions,
): { tuple: OxideEnvTuple; timestampMs: number } {
  const parsed = parseDeployment(selectDeployment(manifest, { portal: profile.portal }))
  if (opts) assertProdOxideTuple(parsed.tuple, opts)
  return parsed
}

export interface LoadOxideManifestOpts {
  /** The pinned manifest URL to fetch. */
  manifestUrl: string
  portal: string
  /** MAINNET applies the prod-schema gate + entryPoint/ensDomain overlay; other networks bare-extract. */
  network: Network
  /** Required on MAINNET: the manifest gitSha must match (fatal on mismatch). */
  expectedGitSha?: string
  /** Injectable fetch implementation; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** Fetch and validate a pinned Oxide manifest into the tuple every direct consumer shares. */
export async function loadOxideManifestTuple(opts: LoadOxideManifestOpts): Promise<OxideEnvTuple> {
  const response = await (opts.fetchImpl ?? fetch)(opts.manifestUrl)
  if (!response.ok) {
    throw new Error(`oxide manifest HTTP ${response.status} (${opts.manifestUrl})`)
  }
  const { tuple } = extractPinnedOxideEnvTuple(await response.json(), opts, pinnedEntryPolicy(opts))
  if (opts.network === Network.MAINNET) {
    return Object.freeze({
      ...tuple,
      entryPoint: MAINNET_ENTRY_POINT,
      ensDomain: MAINNET_ENS_DOMAIN,
    })
  }
  return tuple
}
