/**
 * Whether an amount fits the portal's shared deposit capacity, from one store state. Pure: every screen that asks
 * the same question about the same state gets the same answer. Amounts stay in settlement-token base units.
 *
 * A capacity read reserves nothing. `fits` means the amount fits the observed capacity, not that a later deposit
 * will be processed without waiting.
 */
import type { OperationCapFact, PortalCapacitySnapshot } from "@obsidion/sdk"
import {
  DEFAULT_PORTAL_CAPACITY_POLICY,
  type CapacityUnsupportedReason,
  type HeadCheck,
  type PortalCapacityState,
} from "./portalCapacityStore"

/**
 * The net amount the portal would credit, which is what its capacity meters. The route computes it after its own
 * fees. A route that cannot establish it (a conversion without a supported output bound) passes `unknown`.
 */
export type RequiredCredit =
  | { status: "known"; atomic: bigint; token: string; decimals: number }
  | { status: "unknown" }

/**
 * Time until the shortfall refills. `none`: the portal refills at rate zero. `unsupported`: no supported refill
 * calculation is available to this wallet, so no time is shown.
 */
export type CapacityEstimate =
  | { status: "supported"; seconds: bigint }
  | { status: "unsupported" }
  | { status: "none" }

interface Observed {
  snapshot: PortalCapacitySnapshot
  fetchedAt: number
}

export type CapacityEligibility =
  | { kind: "checking" }
  | ({ kind: "stale"; reason: "age" } & Observed)
  | ({ kind: "stale"; reason: "head"; head: HeadCheck } & Observed)
  | {
      kind: "unavailable"
      error: unknown
      lastSnapshot?: PortalCapacitySnapshot
      lastFetchedAt?: number
    }
  | {
      kind: "unsupported"
      reason: CapacityUnsupportedReason | "amount-token-mismatch" | "amount-decimals-mismatch"
      detail: string
    }
  /** Above the per-operation cap. Refill cannot help. */
  | { kind: "exceeds-operation-cap"; requiredAtomic: bigint; operationCap: OperationCapFact }
  /** Capacity is known; no amount to compare. */
  | ({ kind: "amount-unknown"; low: boolean; zero: boolean } & Observed)
  /** Above the bucket ceiling. Even a full bucket cannot take it. */
  | ({ kind: "exceeds-ceiling"; requiredAtomic: bigint } & Observed)
  | ({
      kind: "exceeds-available"
      requiredAtomic: bigint
      shortfallAtomic: bigint
      estimate: CapacityEstimate
    } & Observed)
  | ({ kind: "fits"; requiredAtomic: bigint; low: boolean } & Observed)

export interface CapacityEligibilityInput {
  state: PortalCapacityState
  required: RequiredCredit
  operationCap: OperationCapFact
  /** Epoch ms. */
  now: number
  /** Defaults to the store policy default. Pass the store's `policy.staleAfterMs` when it differs. */
  staleAfterMs?: number
}

export function evaluateCapacityEligibility(input: CapacityEligibilityInput): CapacityEligibility {
  const { state, required, operationCap } = input
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_PORTAL_CAPACITY_POLICY.staleAfterMs
  const snapshot = "snapshot" in state ? state.snapshot : undefined

  if (required.status === "known") {
    if (required.token.toLowerCase() !== state.key.token.toLowerCase()) {
      return {
        kind: "unsupported",
        reason: "amount-token-mismatch",
        detail: `amount is in ${required.token}; capacity is metered in ${state.key.token}`,
      }
    }
    if (snapshot && required.decimals !== snapshot.decimals) {
      return {
        kind: "unsupported",
        reason: "amount-decimals-mismatch",
        detail: `amount has ${required.decimals} decimals; the token has ${snapshot.decimals}`,
      }
    }
    if (required.atomic > operationCap.sourceAtomic) {
      return { kind: "exceeds-operation-cap", requiredAtomic: required.atomic, operationCap }
    }
  }

  switch (state.status) {
    case "loading":
      return { kind: "checking" }
    case "unsupported":
      return { kind: "unsupported", reason: state.reason, detail: state.detail }
    case "unavailable":
      return {
        kind: "unavailable",
        error: state.error,
        lastSnapshot: state.lastSnapshot,
        lastFetchedAt: state.lastFetchedAt,
      }
    case "stale": {
      const observed = { snapshot: state.snapshot, fetchedAt: state.fetchedAt }
      return state.reason === "head"
        ? { kind: "stale", reason: "head", head: state.head, ...observed }
        : { kind: "stale", reason: "age", ...observed }
    }
  }

  const observed: Observed = { snapshot: state.snapshot, fetchedAt: state.fetchedAt }
  // Timers in a background tab can fire late; the age is checked again here, from the start of the read.
  if (input.now - state.fetchedAt >= staleAfterMs)
    return { kind: "stale", reason: "age", ...observed }

  const { availableAtomic, globalLimitAtomic, rateAtomicPerSecond } = state.snapshot
  const low =
    availableAtomic <
    (operationCap.sourceAtomic < globalLimitAtomic ? operationCap.sourceAtomic : globalLimitAtomic)

  if (required.status === "unknown" || required.atomic <= 0n) {
    return { kind: "amount-unknown", low, zero: availableAtomic === 0n, ...observed }
  }
  if (required.atomic > globalLimitAtomic) {
    return { kind: "exceeds-ceiling", requiredAtomic: required.atomic, ...observed }
  }
  if (required.atomic > availableAtomic) {
    return {
      kind: "exceeds-available",
      requiredAtomic: required.atomic,
      shortfallAtomic: required.atomic - availableAtomic,
      estimate: rateAtomicPerSecond === 0n ? { status: "none" } : { status: "unsupported" },
      ...observed,
    }
  }
  return { kind: "fits", requiredAtomic: required.atomic, low, ...observed }
}

/** A fresh `fits`: the only eligibility that establishes the amount fits. */
export function isCapacityAffirmative(
  eligibility: CapacityEligibility,
): eligibility is Extract<CapacityEligibility, { kind: "fits" }> {
  return eligibility.kind === "fits"
}
