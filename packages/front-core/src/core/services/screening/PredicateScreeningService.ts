import type { Query, QueryFactory } from "../../../engine/query"

const PREDICATE_BASE_URL = "https://api.predicate.io"
const DEFAULT_TIMEOUT_MS = 5_000
// Blocked verdicts are held briefly so a user staring at the field doesn't re-query on every
// keystroke, but a policy change is picked up soon after.
const BLOCKED_TTL_MS = 60_000

export interface PredicateScreeningConfig {
  /** Predicate `x-api-key`. Omit when `baseUrl` points at a proxy that injects the key server-side. */
  apiKey?: string
  /** Managed policy id (`x-managed-policy-…`) sent as `verification_hash`; defines what counts as blocked. */
  verificationHash: string
  /** Predicate chain name, e.g. `ethereum-mainnet`, `ethereum-sepolia`. */
  chain: string
  /** Predicate API base; their staging tier is `https://staging.api.predicate.io`. Default production. */
  baseUrl?: string
  /** Per-request timeout. Default DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number
}

/** Machine code + user-facing message Predicate attaches to a non-compliant verdict. */
export interface ScreeningReason {
  code: string
  message: string
}

export type ScreeningVerdict = { compliant: true } | { compliant: false; reason?: ScreeningReason }

/**
 * Screens an L1 address against a compliance policy. `screen` THROWS on transport failure —
 * callers must treat a throw as "verdict unknown" and fail closed, never as a pass.
 */
export interface AddressScreener {
  screen(address: string): Promise<ScreeningVerdict>
}

/** For builds with no screening configured (sandbox / local dev): every address passes. */
export const passThroughScreener: AddressScreener = {
  screen: () => Promise.resolve({ compliant: true }),
}

interface PredicateAttestationResponse {
  is_compliant: boolean
  reason?: ScreeningReason
}

/**
 * Predicate `/v2/attestation` client — the same endpoint and policy oxide's relayer enforces at
 * withdrawal-batching time, so this client-side verdict is a pre-flight of the relayer's (a
 * blocked recipient there means a burned-but-never-finalized withdrawal; here it's a disabled
 * button). Uncached: {@link screenings} keeps the verdicts.
 */
export class PredicateScreeningService implements AddressScreener {
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(private readonly config: PredicateScreeningConfig) {
    this.baseUrl = config.baseUrl ?? PREDICATE_BASE_URL
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async screen(address: string): Promise<ScreeningVerdict> {
    const response = await fetch(`${this.baseUrl}/v2/attestation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { "x-api-key": this.config.apiKey } : {}),
      },
      body: JSON.stringify({
        verification_hash: this.config.verificationHash,
        from: address,
        chain: this.config.chain,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`Predicate attestation returned ${response.status}`)
    }
    const body = (await response.json()) as PredicateAttestationResponse
    return body.is_compliant ? { compliant: true } : { compliant: false, reason: body.reason }
  }
}

/** The page's verdicts per address. */
export type Screenings = Query<[address: string], ScreeningVerdict>

/**
 * One check per wallet: a compliant address keeps its verdict for the page's life (the relayer
 * re-enforces the policy at commit time), a blocked one for BLOCKED_TTL_MS, and a failure is
 * read again on the next screen.
 */
export function screenings(query: QueryFactory, screener: AddressScreener): Screenings {
  return query<[address: string], ScreeningVerdict>("screening", {
    load: (address) => screener.screen(address),
    stale: (verdict, ageMs) => !verdict.compliant && ageMs >= BLOCKED_TTL_MS,
  })
}

/** Screens through the page's verdicts. */
export const screenerOf = (verdicts: Screenings): AddressScreener => ({
  screen: (address) => verdicts(address.trim()).read(),
})
