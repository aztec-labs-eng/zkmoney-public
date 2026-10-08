/**
 * Copy for the About limits sheet. The sheet explains three separate controls: the per-transaction
 * product maximum, the deposit capacity every user shares, and the account's sponsored-transaction
 * allowance. Every value is supplied by its owner; a value that was not read stays unknown rather
 * than falling back to a default.
 */
import type { AllowanceUsage } from "@obsidion/front-core"
import type { IconName } from "@obsidion/web-ds"
import { ALLOWANCE_SCOPE, formatPeriod } from "../allowance/allowanceView"
import {
  capacityAmount,
  CAPACITY_CHECKING,
  CAPACITY_NOT_RESERVED_NOTE,
  CAPACITY_UNAVAILABLE,
} from "../deposit/fundingCapacity"
import { nominalValuationNote } from "./publicLimit"

/** Product maximum for one kind of transaction, as the product-limit policy defines it. */
export interface OperationLimitFact {
  /** Decimal USD string. */
  maximumUsd: string
  /** Deposits count the value sent; withdrawals count the balance debit. Both include fees. */
  basis: "sent-including-fees" | "debited-including-fees"
}

/** The tokens the policy values at a fixed $1 each. It is not a market price. */
export interface NominalValuationFact {
  tokens: string[]
}

export interface ProductLimitFacts {
  deposit?: OperationLimitFact
  withdrawal?: OperationLimitFact
  valuation?: NominalValuationFact
}

export type CapacityReadState = "loading" | "fresh" | "stale" | "unavailable" | "unsupported"

/** One read of the shared deposit capacity, in the settlement token's base units. */
export interface CapacityObservation {
  available: bigint
  ceiling: bigint
  ratePerSecond: bigint
  decimals: number
  tokenSymbol: string
  /** Epoch ms. */
  observedAt: number
}

export interface CapacityFacts {
  state: CapacityReadState
  /** Shown only for a fresh or stale read. */
  observation?: CapacityObservation
  /** The available figure in the funding panel's words; the view formats `observation` without it. */
  label?: string
  /** The funding panel's sentence for a current read, such as low or no capacity. */
  notice?: string
  /** The funding panel offers Check again for this current read. */
  offerRetry?: boolean
}

/** `general`: no capacity source is connected, so only the explanation is shown. */
export type CapacityViewState = CapacityReadState | "general"

/**
 * `maxTx` and `refillPeriodSeconds` are the rail's configured allowance and renewal period.
 * `renewal-unknown`: none stored on a renewing rail; the read cannot tell whether the next eligible
 * action starts a new allowance. `spent`: none stored on a rail that never renews. `usage`: what
 * spent the current allowance, when it could be read.
 */
export type SponsorshipFacts =
  | { state: "loading" | "unavailable" | "unsupported" | "no-account" }
  | { state: "not-subscribed"; maxTx: number; renews?: boolean; refillPeriodSeconds?: number }
  | {
      state: "available"
      uses: number
      maxTx?: number
      renews?: boolean
      refillPeriodSeconds?: number
      usage?: AllowanceUsage
    }
  | {
      state: "renewal-unknown"
      maxTx: number
      refillPeriodSeconds?: number
      usage?: AllowanceUsage
    }
  | { state: "spent"; usage?: AllowanceUsage }

export type SponsorshipState = SponsorshipFacts["state"]

export interface AboutLimitsFacts {
  product: ProductLimitFacts
  capacity?: CapacityFacts
  sponsorship: SponsorshipFacts
}

export interface AboutLimitsFormat {
  /** Clock time of a capacity read. */
  time: (ms: number) => string
}

const DEFAULT_FORMAT: AboutLimitsFormat = {
  time: (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
}

export type LimitsStatusIcon = Extract<
  IconName,
  "hourglass" | "check-circle" | "clock" | "alert-triangle" | "info-circle" | "x-circle"
>

export interface LimitsRow {
  label: string
  value: string
}

export interface LimitsSectionView<S extends string> {
  state: S
  /** Live-region text. It holds the state only, so a clock change is not announced. */
  status?: { text: string; icon: LimitsStatusIcon }
  rows: LimitsRow[]
  notes: string[]
}

export interface AboutLimitsView {
  operation: LimitsSectionView<"known" | "partial" | "unknown">
  capacity: LimitsSectionView<CapacityViewState> & { canRetry: boolean }
  sponsorship: LimitsSectionView<SponsorshipState> & { canRetry: boolean }
}

export const CAPACITY_DISCLOSURE =
  "Capacity is shared by everyone and refills continuously. It does not reset at midnight."

const NO_REFILL_DISCLOSURE =
  "Capacity is shared by everyone. No automatic refill is configured. It does not reset at midnight."

const UNAVAILABLE = "Unavailable"

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")

function usdLabel(decimal: string): string | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal)
  if (!match) return undefined
  const cents = match[2]?.replace(/0+$/, "")
  return `$${group(match[1])}${cents ? `.${cents.padEnd(2, "0")}` : ""}`
}

function rateLabel({ ratePerSecond, decimals, tokenSymbol }: CapacityObservation): string {
  if (ratePerSecond === 0n) return "No automatic refill"
  const perMinute = ratePerSecond * 60n
  const cent = 10n ** BigInt(Math.max(decimals - 2, 0))
  return perMinute < cent
    ? `Less than 0.01 ${tokenSymbol} per minute`
    : `${capacityAmount(perMinute, decimals, tokenSymbol)} per minute`
}

function orList(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`
}

function operationView(product: ProductLimitFacts): AboutLimitsView["operation"] {
  const deposit = product.deposit && usdLabel(product.deposit.maximumUsd)
  const withdrawal = product.withdrawal && usdLabel(product.withdrawal.maximumUsd)
  const value = (label: string | undefined, fact: OperationLimitFact | undefined) =>
    label
      ? `${label} ${fact!.basis === "sent-including-fees" ? "sent" : "from balance"}, incl. fees`
      : UNAVAILABLE
  const notes: string[] = []
  const tokens = product.valuation?.tokens ?? []
  if ((deposit || withdrawal) && tokens.length > 0) {
    notes.push(
      nominalValuationNote(orList(tokens)),
      "It does not set what a converted deposit credits or how much capacity it uses.",
    )
  }
  if (deposit || withdrawal) {
    notes.push(
      "It applies to each transaction and does not change over time. There is no daily limit and no limit on your balance.",
    )
  }
  // A deposit address is single-use, so a larger deposit is several deposits, not several transfers.
  if (deposit) {
    notes.push(
      "To deposit more, make separate deposits. Each one uses a new address and pays its own fee.",
    )
  }
  if (withdrawal)
    notes.push("To withdraw more, make separate withdrawals. Each one pays its own fee.")
  return {
    state: deposit && withdrawal ? "known" : deposit || withdrawal ? "partial" : "unknown",
    rows: [
      { label: "Per deposit", value: value(deposit, product.deposit) },
      { label: "Per withdrawal", value: value(withdrawal, product.withdrawal) },
    ],
    notes,
  }
}

const CAPACITY_STATUS: Record<CapacityReadState, { text: string; icon: LimitsStatusIcon }> = {
  loading: { text: CAPACITY_CHECKING, icon: "hourglass" },
  fresh: { text: "Capacity up to date", icon: "check-circle" },
  stale: { text: "Capacity out of date", icon: "clock" },
  unavailable: { text: CAPACITY_UNAVAILABLE, icon: "alert-triangle" },
  unsupported: { text: "Capacity can't be checked on this network.", icon: "info-circle" },
}

const WITHDRAWALS_NOTE = "Withdrawals do not restore deposit capacity."

function capacityView(
  capacity: CapacityFacts | undefined,
  format: AboutLimitsFormat,
): AboutLimitsView["capacity"] {
  if (!capacity) {
    return {
      state: "general",
      rows: [],
      notes: [CAPACITY_DISCLOSURE, WITHDRAWALS_NOTE, CAPACITY_NOT_RESERVED_NOTE],
      canRetry: false,
    }
  }
  const read = capacity.state === "fresh" || capacity.state === "stale"
  // A read state without its values is shown as a failed read, never as zero capacity.
  const state = read && !capacity.observation ? "unavailable" : capacity.state
  const observation = read ? capacity.observation : undefined
  const rows = observation
    ? [
        {
          label: "Available",
          value:
            capacity.label ??
            capacityAmount(observation.available, observation.decimals, observation.tokenSymbol),
        },
        {
          label: "Total capacity",
          value: capacityAmount(observation.ceiling, observation.decimals, observation.tokenSymbol),
        },
        { label: "Refill rate", value: rateLabel(observation) },
        { label: "Last checked", value: format.time(observation.observedAt) },
      ]
    : []
  const noRefill = observation?.ratePerSecond === 0n
  return {
    state,
    status:
      state === "fresh" && capacity.notice
        ? { text: capacity.notice, icon: "alert-triangle" }
        : CAPACITY_STATUS[state],
    rows,
    notes: [
      noRefill ? NO_REFILL_DISCLOSURE : CAPACITY_DISCLOSURE,
      WITHDRAWALS_NOTE,
      CAPACITY_NOT_RESERVED_NOTE,
    ],
    canRetry:
      state === "stale" || state === "unavailable" || (state === "fresh" && !!capacity.offerRetry),
  }
}

const RENEWAL_NOTE = "It does not reset at midnight."

// The contract renews only a used-up allowance, on the first eligible action once the period has
// passed; while uses remain, each action spends one.
function renewsRow(
  renews: boolean | undefined,
  refillPeriodSeconds: number | undefined,
  since: string,
) {
  const value =
    renews === undefined
      ? "Unknown"
      : !renews
      ? "No"
      : refillPeriodSeconds
      ? `When used up, ${formatPeriod(refillPeriodSeconds)} after ${since}`
      : "When used up"
  return { label: "Renews", value }
}

const SCOPE_NOTE = ALLOWANCE_SCOPE

const NO_RENEWAL_NOTE = "This allowance does not renew."

const status = (text: string, icon: LimitsStatusIcon) => ({ text, icon })

function usageRows(usage: AllowanceUsage | undefined): LimitsRow[] {
  if (!usage) return []
  return [
    { label: "Used by your transactions", value: String(usage.yours) },
    { label: "Used by deposit addresses", value: String(usage.depositAddresses) },
  ]
}

function sponsorshipView(sponsorship: SponsorshipFacts): AboutLimitsView["sponsorship"] {
  const section = (
    text: string,
    icon: LimitsStatusIcon,
    rows: LimitsRow[] = [],
    notes: string[] = [],
  ): AboutLimitsView["sponsorship"] => ({
    state: sponsorship.state,
    status: status(text, icon),
    rows,
    notes: [SCOPE_NOTE, ...notes],
    canRetry: sponsorship.state === "unavailable",
  })
  switch (sponsorship.state) {
    case "loading":
      return section("Checking sponsored transactions…", "hourglass")
    case "unavailable":
      return section("Sponsored transactions could not be checked.", "alert-triangle")
    case "unsupported":
      return section(
        "Sponsored transaction details are not available for this deployment.",
        "info-circle",
      )
    case "no-account":
      return section("Sponsored transactions come with a zk.money account.", "info-circle")
    case "not-subscribed": {
      // The first sponsored batch opens the allowance and spends one of its uses.
      const { maxTx, renews, refillPeriodSeconds } = sponsorship
      return section(
        "Sponsored transactions not started yet",
        "info-circle",
        [
          { label: "First allowance", value: String(maxTx) },
          renewsRow(renews, refillPeriodSeconds, "it opened"),
        ],
        [
          maxTx === 1
            ? "Your first sponsored transaction opens a one-use allowance and uses it."
            : `Your first sponsored transaction opens an allowance of ${maxTx} and uses one of them.`,
          ...(renews ? [RENEWAL_NOTE] : renews === false ? [NO_RENEWAL_NOTE] : []),
        ],
      )
    }
    case "available": {
      const { uses, maxTx, renews, refillPeriodSeconds } = sponsorship
      return section(
        `${uses} sponsored ${uses === 1 ? "transaction" : "transactions"} left`,
        "check-circle",
        [
          ...(maxTx === undefined ? [] : [{ label: "Allowance", value: String(maxTx) }]),
          ...usageRows(sponsorship.usage),
          renewsRow(renews, refillPeriodSeconds, "the last renewal"),
        ],
        renews ? [RENEWAL_NOTE] : renews === false ? [NO_RENEWAL_NOTE] : [],
      )
    }
    case "renewal-unknown": {
      // A stored zero on a renewing rail never holds an action back: the chain decides.
      const { maxTx, refillPeriodSeconds } = sponsorship
      return section(
        "Renewal status unknown",
        "info-circle",
        [
          { label: "Allowance", value: String(maxTx) },
          ...usageRows(sponsorship.usage),
          renewsRow(true, refillPeriodSeconds, "the last renewal"),
        ],
        [
          "We can't confirm renewal yet. Your next eligible transaction may start a new allowance.",
          RENEWAL_NOTE,
        ],
      )
    }
    case "spent":
      return section(
        "No sponsored transactions left",
        "x-circle",
        [...usageRows(sponsorship.usage), { label: "Renews", value: "No" }],
        [NO_RENEWAL_NOTE],
      )
  }
}

export function aboutLimitsView(
  facts: AboutLimitsFacts,
  format: AboutLimitsFormat = DEFAULT_FORMAT,
): AboutLimitsView {
  return {
    operation: operationView(facts.product),
    capacity: capacityView(facts.capacity, format),
    sponsorship: sponsorshipView(facts.sponsorship),
  }
}

/** The section a caller opens the sheet on: the per-transaction limit, capacity or sponsorship. */
export type LimitsTopic = "limit" | "capacity" | "sponsorship"
