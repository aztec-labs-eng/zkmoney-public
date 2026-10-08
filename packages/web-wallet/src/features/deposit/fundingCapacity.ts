/**
 * What a funding surface says about shared deposit capacity, from a store state's eligibility. Pure, so the
 * connected deposit form, address surfaces and the limits sheet word the same state the same way.
 */
import { formatUnits } from "viem"
import {
  evaluateCapacityEligibility,
  floorToTypeable,
  PortalCapacityReferenceError,
  type CapacityEligibility,
  type CapacityEligibilityInput,
  type PortalCapacityState,
} from "@obsidion/front-core"

/** `editable`: the user types the amount. `fixed`: a request fixes it. `address`: no amount; never gates sharing. */
export type FundingMode = "editable" | "fixed" | "address"

/**
 * What capacity establishes about new funding. `unknown`: no current read, a portal without capacity getters, or a
 * credit the route cannot compute. `short`: known capacity cannot take the deposit, now or ever; an empty bucket takes
 * no positive deposit. `unsupported`: the chain, portal, token or decimals do not match the bucket, including a node
 * that follows another chain.
 */
export type CapacityFinding = "fits" | "unknown" | "short" | "unsupported"

/**
 * How new funding treats an `unknown` finding. `hold`: it waits, and the capacity line says why. `proceed`: it goes
 * ahead and nothing is said.
 */
export type UnknownCapacityPolicy = "hold" | "proceed"

export function capacityFinding(eligibility: CapacityEligibility): CapacityFinding {
  switch (eligibility.kind) {
    case "fits":
      return "fits"
    case "checking":
    case "stale":
      return "unknown"
    case "unavailable":
      return eligibility.error instanceof PortalCapacityReferenceError &&
        eligibility.error.reason === "chain-mismatch"
        ? "unsupported"
        : "unknown"
    case "amount-unknown":
      return eligibility.zero ? "short" : "unknown"
    case "exceeds-operation-cap":
    case "exceeds-ceiling":
    case "exceeds-available":
      return "short"
    case "unsupported":
      return eligibility.reason === "no-capacity-getters" ? "unknown" : "unsupported"
  }
}

/** Capacity alone allows new funding. The form and the last check before a transfer both ask this. */
export function capacityAllowsFunding(
  eligibility: CapacityEligibility,
  unknownCapacity: UnknownCapacityPolicy,
): boolean {
  const finding = capacityFinding(eligibility)
  return finding === "fits" || (finding === "unknown" && unknownCapacity === "proceed")
}

/**
 * Eligibility for new funding. Under `proceed`, a failed read does not hide a shortfall or mismatch that the last
 * fresh snapshot shows while that snapshot is still current.
 */
export function fundingEligibility(
  input: CapacityEligibilityInput & { unknownCapacity?: UnknownCapacityPolicy },
): CapacityEligibility {
  const eligibility = evaluateCapacityEligibility(input)
  const { state } = input
  if (
    input.unknownCapacity !== "proceed" ||
    state.status !== "unavailable" ||
    !state.lastWasFresh ||
    !state.lastSnapshot ||
    state.lastFetchedAt === undefined
  ) {
    return eligibility
  }
  const last = evaluateCapacityEligibility({
    ...input,
    state: {
      status: "fresh",
      key: state.key,
      snapshot: state.lastSnapshot,
      fetchedAt: state.lastFetchedAt,
    },
  })
  const finding = capacityFinding(last)
  return finding === "short" || finding === "unsupported" ? last : eligibility
}

export const CAPACITY_NOT_RESERVED_NOTE =
  "Sending doesn't reserve capacity. If it runs out first, processing waits and your funds stay at the deposit address."
export const CAPACITY_CHECKING = "Checking capacity…"
export const CAPACITY_UNAVAILABLE = "Capacity could not be checked."
export const CAPACITY_FITS = "Fits the current capacity."
export const CAPACITY_LOW = "Network capacity is low."
export const CAPACITY_NONE = "No network capacity is available right now."

export interface FundingCapacityInput {
  eligibility: CapacityEligibility
  mode: FundingMode
  /** Symbol of the settlement token capacity is metered in. */
  symbol: string
  /** Symbol of the token being sent. */
  sentSymbol: string
  /** The portal credits exactly the entered amount (settlement-token route). */
  exactCredit: boolean
  /** Smallest amount the form accepts; "Use available amount" is not offered below it. */
  minimumAtomic?: bigint
  /** Defaults to `hold`. */
  unknownCapacity?: UnknownCapacityPolicy
}

export interface FundingCapacityView {
  tone: "ok" | "warn" | "blocked" | "checking"
  /** One sentence about this amount and the current capacity. */
  statusText?: string
  /** What happens next: refill, or what to check. */
  detailText?: string
  /** Capacity alone allows new funding. Callers combine it with their own gates. */
  canFund: boolean
  offerRetry: boolean
  /** Entered amount for "Use available amount", when that is a valid smaller amount. */
  availableAmount?: string
}

/** `12,400.5 DAI`, rounded down to cents so a shown amount never exceeds the real one. */
export function capacityAmount(atomic: bigint, decimals: number, symbol: string): string {
  const cents =
    decimals > 2 ? atomic / 10n ** BigInt(decimals - 2) : atomic * 10n ** BigInt(2 - decimals)
  const whole = (cents / 100n).toLocaleString("en-US")
  const fraction = (cents % 100n).toString().padStart(2, "0").replace(/0+$/, "")
  return `${fraction ? `${whole}.${fraction}` : whole} ${symbol}`
}

/** The capacity row's text for a store state. The limits sheet uses the same words. */
export function capacityStateLabel(state: PortalCapacityState | undefined, symbol: string): string {
  if (!state || state.status === "loading") return CAPACITY_CHECKING
  if (state.status === "unsupported") return "Unavailable"
  if (state.status === "unavailable") {
    return state.lastSnapshot
      ? `${capacityAmount(
          state.lastSnapshot.availableAtomic,
          state.lastSnapshot.decimals,
          symbol,
        )} (not current)`
      : "Unavailable"
  }
  const figure = capacityAmount(state.snapshot.availableAtomic, state.snapshot.decimals, symbol)
  return state.status === "stale" ? `${figure} (not current)` : figure
}

function refillText(estimate: { status: string; seconds?: bigint }): string {
  if (estimate.status === "none") return "No automatic refill is configured."
  if (estimate.status === "supported" && estimate.seconds !== undefined) {
    const minutes = (estimate.seconds + 59n) / 60n
    return estimate.seconds < 60n
      ? "Enough capacity in less than 1 minute, if no one else uses it."
      : `Enough capacity in about ${minutes} min, if no one else uses it.`
  }
  return "Capacity refills continuously. Check again later."
}

export function fundingCapacityView(input: FundingCapacityInput): FundingCapacityView {
  const { eligibility, mode, symbol } = input
  const blocked = (
    statusText: string,
    detailText?: string,
    offerRetry = true,
  ): FundingCapacityView => ({
    tone: "blocked",
    statusText,
    detailText,
    canFund: false,
    offerRetry,
  })

  if (input.unknownCapacity === "proceed" && capacityFinding(eligibility) === "unknown") {
    return { tone: "ok", canFund: true, offerRetry: false }
  }

  switch (eligibility.kind) {
    case "checking":
      return { tone: "checking", canFund: false, offerRetry: false }
    case "stale":
      if (eligibility.reason === "age") return blocked("This capacity reading is out of date.")
      if (eligibility.head.cause === "old") {
        return blocked(
          "The capacity reading looks out of date.",
          "Check that your device's date and time are correct, then check again.",
        )
      }
      return blocked(
        eligibility.head.cause === "stalled"
          ? "The network's latest data has not changed for a while."
          : "The network answered with older data.",
        "Check again in a moment.",
      )
    case "unavailable":
      return blocked(CAPACITY_UNAVAILABLE)
    case "unsupported":
      return blocked("Capacity can't be checked for this deposit.", undefined, false)
    case "exceeds-operation-cap":
      // The amount form names this limit; refill cannot help, so nothing is added here.
      return { tone: "blocked", canFund: false, offerRetry: false }
    case "amount-unknown": {
      if (eligibility.zero) {
        return {
          tone: "warn",
          statusText: CAPACITY_NONE,
          canFund: false,
          offerRetry: true,
        }
      }
      if (mode !== "address" && !input.exactCredit) {
        return blocked(
          `Capacity can't be checked for ${input.sentSymbol} deposits right now.`,
          undefined,
          false,
        )
      }
      return eligibility.low
        ? { tone: "warn", statusText: CAPACITY_LOW, canFund: false, offerRetry: false }
        : { tone: "ok", canFund: false, offerRetry: false }
    }
    case "exceeds-ceiling":
      return {
        ...blocked(
          "This amount can't fit the network's deposit capacity, even when it is full.",
          undefined,
          false,
        ),
        availableAmount: useAvailable(
          input,
          eligibility.snapshot.availableAtomic,
          eligibility.snapshot.decimals,
        ),
      }
    case "exceeds-available": {
      const { snapshot } = eligibility
      const needs = capacityAmount(eligibility.requiredAtomic, snapshot.decimals, symbol)
      const available = capacityAmount(snapshot.availableAtomic, snapshot.decimals, symbol)
      const what = mode === "fixed" ? "This payment" : "This deposit"
      return {
        ...blocked(
          `${what} needs ${needs}; ${available} is available now.`,
          refillText(eligibility.estimate),
        ),
        availableAmount: useAvailable(input, snapshot.availableAtomic, snapshot.decimals),
      }
    }
    case "fits":
      return eligibility.low
        ? {
            tone: "warn",
            statusText: CAPACITY_FITS,
            detailText: CAPACITY_LOW,
            canFund: true,
            offerRetry: false,
          }
        : { tone: "ok", statusText: CAPACITY_FITS, canFund: true, offerRetry: false }
  }
}

/** A smaller amount the user can pick, only where the entered amount is exactly what the portal credits. */
function useAvailable(input: FundingCapacityInput, availableAtomic: bigint, decimals: number) {
  if (input.mode !== "editable" || !input.exactCredit) return undefined
  const atomic = floorToTypeable(availableAtomic, decimals)
  if (atomic <= 0n || atomic < (input.minimumAtomic ?? 1n)) return undefined
  return formatUnits(atomic, decimals)
}
