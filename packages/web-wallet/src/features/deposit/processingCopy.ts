/**
 * What a deposit sheet says about a deposit waiting for its sweep. The headline is the shared wording the activity row
 * and the notification also use. A reading describes the current blocker only: nothing here says why an earlier sweep
 * failed, and nothing promises the deposit will be swept on its own once capacity returns.
 */
import { formatUnits } from "viem"
import {
  SIPA_PROCESSING_COPY,
  type SipaProcessingState,
  type SipaSweepBlocker,
} from "@obsidion/front-core"

export interface ProcessingCopy {
  headline: string
  /** Where the funds are and what can move them; shown under the headline where it applies. */
  funds?: string
  /** The rest of the explanation, for the details. */
  lines: string[]
  /** When the read this copy rests on started. */
  checkedAt?: number
  /** Whether a new read could change the answer. Refill never lifts an oversized deposit. */
  canCheckAgain: boolean
}

/** `1,234.5 DAI`: capacity is counted in the settlement token, never in dollars. */
export function capacityAmount(atomic: bigint, decimals: number, symbol: string): string {
  const value = Number(formatUnits(atomic, decimals))
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${symbol}`
}

/** `about 44 min`, rounded up to the minute. */
function waitLabel(seconds: bigint): string {
  const minutes = Number((seconds + 59n) / 60n)
  if (minutes < 60) return `about ${Math.max(minutes, 1)} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `about ${hours} h ${rest} min` : `about ${hours} h`
}

const FUNDS_STAY = "Your funds remain at your Ethereum deposit address."

/** What a remembered blocker established, for a read that cannot confirm it. Only a capacity wait can clear. */
const LAST_KNOWN: Record<SipaSweepBlocker["kind"], string> = {
  "capacity": "Network capacity was insufficient when last checked",
  "ceiling":
    "The last reading showed this deposit is larger than the network's total deposit capacity",
  "operation-cap": "This deposit is larger than the network can process in one deposit",
}

const isBlockerKind = (kind: SipaProcessingState["reason"]["kind"]) =>
  kind === "capacity" || kind === "ceiling" || kind === "operation-cap"

/** `symbol` is the settlement token capacity is metered in. */
export function processingCopy(state: SipaProcessingState, symbol: string): ProcessingCopy {
  const copy = reasonCopy(state, symbol)
  const { blocker } = state
  // A blocker survives a read that cannot confirm it is gone; say why the sweep still waits.
  if (blocker && !isBlockerKind(state.reason.kind)) {
    copy.lines.push(
      `${LAST_KNOWN[blocker.kind]}, so the manual sweep stays unavailable${
        blocker.kind === "capacity" ? " until a new reading shows enough" : ""
      }.`,
    )
  }
  return copy
}

/**
 * One line for a held deposit where a surface has room for no more: the current blocker's headline, or what the last
 * reading established when the current read cannot confirm it. Undefined when nothing holds the deposit.
 */
export function heldDepositLine(state: SipaProcessingState | undefined): string | undefined {
  if (!state?.blocker) return undefined
  return isBlockerKind(state.reason.kind)
    ? `${SIPA_PROCESSING_COPY[state.reason.kind].headline}.`
    : `${LAST_KNOWN[state.blocker.kind]}.`
}

function reasonCopy(state: SipaProcessingState, symbol: string): ProcessingCopy {
  const { reason } = state
  const headline = SIPA_PROCESSING_COPY[reason.kind].headline
  const amount = (atomic: bigint, decimals: number) => capacityAmount(atomic, decimals, symbol)
  switch (reason.kind) {
    case "capacity": {
      const need =
        reason.requiredAtomic === undefined
          ? "No network capacity is available now."
          : `This deposit needs ${amount(reason.requiredAtomic, reason.decimals)}; ${amount(
              reason.availableAtomic,
              reason.decimals,
            )} of network capacity is available now.`
      // Without an estimate, the limits details state the general refill rule.
      const refill =
        reason.refill.status === "none"
          ? ["No automatic refill is configured."]
          : reason.refill.status === "estimate"
          ? [`Estimated capacity in ${waitLabel(reason.refill.seconds)}, if no one else uses it.`]
          : []
      return {
        headline,
        funds: FUNDS_STAY,
        lines: [need, ...refill, "When capacity is available you can sweep it yourself."],
        checkedAt: reason.observedAt,
        canCheckAgain: true,
      }
    }
    case "ceiling":
      return {
        headline,
        lines: [
          `This deposit needs ${amount(
            reason.requiredAtomic,
            reason.decimals,
          )}, more than the network's total deposit capacity of ${amount(
            reason.ceilingAtomic,
            reason.decimals,
          )}. Waiting won't change this.`,
        ],
        funds: `${FUNDS_STAY} Only a recovery can move them.`,
        checkedAt: reason.observedAt,
        canCheckAgain: false,
      }
    case "operation-cap":
      return {
        headline,
        lines: [
          "This deposit is larger than the network can process in one deposit. Waiting won't change this.",
        ],
        funds: `${FUNDS_STAY} Only a recovery can move them.`,
        canCheckAgain: false,
      }
    case "processing":
      return {
        headline,
        funds: FUNDS_STAY,
        lines: ["Capacity is currently sufficient; your deposit is still awaiting processing."],
        checkedAt: reason.observedAt,
        canCheckAgain: true,
      }
    case "checking":
      return {
        headline,
        lines: ["Checking network capacity for this deposit."],
        canCheckAgain: false,
      }
    case "unavailable":
      switch (reason.cause) {
        case "amount-unknown":
          return {
            headline,
            lines: [
              `${amount(
                reason.availableAtomic,
                reason.decimals,
              )} of network capacity is available now. The wallet can't tell how much of this deposit the network would credit, so it can't tell whether it fits.`,
            ],
            funds: FUNDS_STAY,
            checkedAt: reason.observedAt,
            canCheckAgain: true,
          }
        case "capacity-unread":
          return {
            headline,
            lines: [
              "Network capacity could not be checked, so the wallet could not determine why processing is delayed.",
              ...(reason.last
                ? [
                    `The last reading showed ${amount(
                      reason.last.availableAtomic,
                      reason.last.decimals,
                    )} available. It may have changed since.`,
                  ]
                : []),
            ],
            funds: FUNDS_STAY,
            checkedAt: reason.last?.observedAt,
            canCheckAgain: true,
          }
        case "portal-unknown":
          return {
            headline,
            funds: FUNDS_STAY,
            lines: ["The wallet could not determine why processing is delayed."],
            canCheckAgain: true,
          }
      }
  }
}
