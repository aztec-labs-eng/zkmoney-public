import { formatUnits, parseUnits } from "viem"

/**
 * Whether a link's note may start a new ticket signup. `unknown` is an amount or threshold not read
 * yet, or not a base-unit integer: no signup starts on it. The redeem checks the live threshold again.
 */
export type TicketEligibility = "eligible" | "below_threshold" | "unknown"

export const isBaseUnits = (value: string | undefined): value is string =>
  value !== undefined && /^\d+$/.test(value)

/** Both figures in base units; a note equal to the threshold is eligible. */
export function ticketEligibility(
  amount: string | undefined,
  threshold: string | undefined,
): TicketEligibility {
  if (!isBaseUnits(amount) || !isBaseUnits(threshold)) return "unknown"
  return BigInt(amount) >= BigInt(threshold) ? "eligible" : "below_threshold"
}

/** A link's amount in base units. The page's figure is the note's exact `formatUnits` output. */
export function linkBaseUnits(amount: string | undefined, decimals: number): string | undefined {
  if (!amount) return undefined
  try {
    return parseUnits(amount, decimals).toString()
  } catch {
    return undefined
  }
}

/**
 * Whether a link pays a new user's tag: a ticket on offer, a voucher on the link, and a note at the
 * threshold. Undefined where no ticket can apply.
 */
export function linkTicketEligibility(
  offer: { threshold: string } | null | undefined,
  amount: string | undefined,
  voucher: boolean,
): TicketEligibility | undefined {
  return offer && voucher ? ticketEligibility(amount, offer.threshold) : undefined
}

/** The threshold in dollars: the fee token is a dollar stablecoin. */
export const ticketThresholdLabel = (threshold: string, decimals: number) =>
  `$${formatUnits(BigInt(threshold), decimals)}`

/** `minimum` is `ticketThresholdLabel`'s figure. */
export const belowTicketThresholdCopy = (minimum: string) =>
  `This payment is below the ${minimum} minimum for a new account.`

/** What a ticket-sized link gives its recipient, told to the sender. */
export const TICKET_GRANT_COPY =
  "This link can be used by a new user to get their zk.money tag for free."

/** `minimum` is `ticketThresholdLabel`'s figure. */
export const ticketThresholdHint = (minimum: string) =>
  `Links of ${minimum} or more can be used by a new user to get their zk.money tag for free.`
