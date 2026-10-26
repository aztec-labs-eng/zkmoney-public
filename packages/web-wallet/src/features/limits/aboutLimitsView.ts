/**
 * View model for the About limits sheet; its words live in `limitsCopy`. The sheet explains three separate controls: the per-transaction
 * product maximum, the deposit capacity every user shares, and the account's sponsored-transaction
 * allowance. Every value is supplied by its owner; a value that was not read stays unknown rather
 * than falling back to a default.
 */
import type { AllowanceUsage } from "@obsidion/front-core"
import type { IconName } from "@obsidion/web-ds"
import { formatPeriod } from "../allowance/allowanceView"
import { capacityAmount } from "../deposit/fundingCapacity"
import * as copy from "./limitsCopy"

/** Product maximum for one kind of transaction, as the product-limit policy defines it. */
export interface OperationLimitFact {
  /** Decimal USD string. Deposits count the value sent, withdrawals the balance debit; both include fees. */
  maximumUsd: string
}

export interface ProductLimitFacts {
  send?: OperationLimitFact
  deposit?: OperationLimitFact
  withdrawal?: OperationLimitFact
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

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")

function usdLabel(decimal: string): string | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal)
  if (!match) return undefined
  const cents = match[2]?.replace(/0+$/, "")
  return `$${group(match[1])}${cents ? `.${cents.padEnd(2, "0")}` : ""}`
}

function rateLabel({ ratePerSecond, decimals, tokenSymbol }: CapacityObservation): string {
  if (ratePerSecond === 0n) return copy.NO_REFILL
  const perMinute = ratePerSecond * 60n
  const cent = 10n ** BigInt(Math.max(decimals - 2, 0))
  return perMinute < cent
    ? copy.rateUnderCent(tokenSymbol)
    : copy.ratePerMinute(capacityAmount(perMinute, decimals, tokenSymbol))
}

function operationView(product: ProductLimitFacts): AboutLimitsView["operation"] {
  const kinds = ["send", "deposit", "withdrawal"] as const
  const maxima = kinds.map((kind) => {
    const fact = product[kind]
    return fact && usdLabel(fact.maximumUsd)
  })
  const known = maxima.filter(Boolean).length
  return {
    state: known === kinds.length ? "known" : known > 0 ? "partial" : "unknown",
    rows: kinds.map((kind, i) => ({
      label: copy.LIMIT_ROW[kind],
      value: maxima[i] ?? copy.UNAVAILABLE,
    })),
    notes: known > 0 ? [copy.LIMIT_NOTE] : [],
  }
}

const CAPACITY_STATUS: Record<CapacityReadState, { text: string; icon: LimitsStatusIcon }> = {
  loading: { text: copy.CAPACITY_CHECKING, icon: "hourglass" },
  fresh: { text: copy.CAPACITY_FRESH, icon: "check-circle" },
  stale: { text: copy.CAPACITY_STALE, icon: "clock" },
  unavailable: { text: copy.CAPACITY_UNAVAILABLE, icon: "alert-triangle" },
  unsupported: { text: copy.CAPACITY_UNSUPPORTED, icon: "info-circle" },
}

function capacityView(
  capacity: CapacityFacts | undefined,
  format: AboutLimitsFormat,
): AboutLimitsView["capacity"] {
  if (!capacity) {
    return {
      state: "general",
      rows: [],
      notes: [copy.CAPACITY_DISCLOSURE, copy.WITHDRAWALS_NOTE, copy.CAPACITY_NOT_RESERVED_NOTE],
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
          label: copy.CAPACITY_ROW.available,
          value:
            capacity.label ??
            capacityAmount(observation.available, observation.decimals, observation.tokenSymbol),
        },
        {
          label: copy.CAPACITY_ROW.total,
          value: capacityAmount(observation.ceiling, observation.decimals, observation.tokenSymbol),
        },
        { label: copy.CAPACITY_ROW.rate, value: rateLabel(observation) },
        { label: copy.CAPACITY_ROW.checked, value: format.time(observation.observedAt) },
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
      noRefill ? copy.NO_REFILL_DISCLOSURE : copy.CAPACITY_DISCLOSURE,
      copy.WITHDRAWALS_NOTE,
      copy.CAPACITY_NOT_RESERVED_NOTE,
    ],
    canRetry:
      state === "stale" || state === "unavailable" || (state === "fresh" && !!capacity.offerRetry),
  }
}

// The contract renews only a used-up allowance, on the first eligible action once the period has
// passed; while uses remain, each action spends one.
function renewsRow(renews: boolean | undefined, refillPeriodSeconds: number | undefined) {
  const value =
    renews === undefined
      ? copy.RENEWS_VALUE.unknown
      : !renews
      ? copy.RENEWS_VALUE.no
      : refillPeriodSeconds
      ? copy.renewsAfterUsedUp(formatPeriod(refillPeriodSeconds))
      : copy.RENEWS_VALUE.whenUsedUp
  return { label: copy.SPONSORSHIP_ROW.renews, value }
}

const status = (text: string, icon: LimitsStatusIcon) => ({ text, icon })

function usageRows(usage: AllowanceUsage | undefined): LimitsRow[] {
  if (!usage) return []
  return [
    { label: copy.SPONSORSHIP_ROW.usedByYou, value: String(usage.yours) },
    { label: copy.SPONSORSHIP_ROW.usedByAddresses, value: String(usage.depositAddresses) },
  ]
}

function sponsorshipView(sponsorship: SponsorshipFacts): AboutLimitsView["sponsorship"] {
  const section = (
    text: string | undefined,
    icon: LimitsStatusIcon,
    rows: LimitsRow[] = [],
    notes: string[] = [],
  ): AboutLimitsView["sponsorship"] => ({
    state: sponsorship.state,
    status: text === undefined ? undefined : status(text, icon),
    rows,
    notes: [copy.ALLOWANCE_SCOPE, ...notes],
    canRetry: sponsorship.state === "unavailable",
  })
  switch (sponsorship.state) {
    case "loading":
      return section(copy.SPONSORSHIP_STATUS.loading, "hourglass")
    case "unavailable":
      return section(copy.SPONSORSHIP_STATUS.unavailable, "alert-triangle")
    case "unsupported":
      return section(copy.SPONSORSHIP_STATUS.unsupported, "info-circle")
    case "no-account":
      return section(copy.SPONSORSHIP_STATUS.noAccount, "info-circle")
    case "not-subscribed": {
      // The first sponsored batch opens the allowance and spends one of its uses.
      const { maxTx, renews, refillPeriodSeconds } = sponsorship
      return section(undefined, "info-circle", [
        { label: copy.SPONSORSHIP_ROW.firstAllowance, value: String(maxTx) },
        renewsRow(renews, refillPeriodSeconds),
      ])
    }
    case "available": {
      const { uses, maxTx, renews, refillPeriodSeconds } = sponsorship
      return section(copy.usesLeft(uses), "check-circle", [
        ...(maxTx === undefined
          ? []
          : [{ label: copy.SPONSORSHIP_ROW.allowance, value: String(maxTx) }]),
        ...usageRows(sponsorship.usage),
        renewsRow(renews, refillPeriodSeconds),
      ])
    }
    case "renewal-unknown": {
      // A stored zero on a renewing rail never holds an action back: the chain decides.
      const { maxTx, refillPeriodSeconds } = sponsorship
      return section(
        copy.SPONSORSHIP_STATUS.renewalUnknown,
        "info-circle",
        [
          { label: copy.SPONSORSHIP_ROW.allowance, value: String(maxTx) },
          ...usageRows(sponsorship.usage),
          renewsRow(true, refillPeriodSeconds),
        ],
        [copy.RENEWAL_UNKNOWN_NOTE],
      )
    }
    case "spent":
      return section(copy.SPONSORSHIP_STATUS.spent, "x-circle", [
        ...usageRows(sponsorship.usage),
        { label: copy.SPONSORSHIP_ROW.renews, value: copy.RENEWS_VALUE.no },
      ])
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
