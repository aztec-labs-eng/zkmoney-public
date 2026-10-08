import { describe, expect, it } from "vitest"
import {
  aboutLimitsView,
  CAPACITY_DISCLOSURE,
  type AboutLimitsFacts,
  type AboutLimitsView,
  type CapacityFacts,
  type CapacityObservation,
  type ProductLimitFacts,
  type SponsorshipFacts,
} from "../src/features/limits/aboutLimitsView"
import { ALLOWANCE_SCOPE } from "../src/features/allowance/allowanceView"
import { CAPACITY_NONE, CAPACITY_NOT_RESERVED_NOTE } from "../src/features/deposit/fundingCapacity"

const E18 = 10n ** 18n
const format = { time: (ms: number) => `time:${ms}` }

const product: ProductLimitFacts = {
  deposit: { maximumUsd: "2500", basis: "sent-including-fees" },
  withdrawal: { maximumUsd: "2500", basis: "debited-including-fees" },
  valuation: { tokens: ["DAI", "USDC", "USDT"] },
}

const dai: CapacityObservation = {
  available: 1_234_567_890_000_000_000_000n,
  ceiling: 50_000n * E18,
  // 50,000 per 86,400 s, floored to base units.
  ratePerSecond: 578_703_703_703_703_703n,
  decimals: 18,
  tokenSymbol: "DAI",
  observedAt: 1_000,
}

const view = (facts: Partial<AboutLimitsFacts>) =>
  aboutLimitsView(
    {
      product,
      capacity: { state: "fresh", observation: dai },
      sponsorship: { state: "available", uses: 3, renews: true, refillPeriodSeconds: 86_400 },
      ...facts,
    },
    format,
  )

const row = (section: { rows: { label: string; value: string }[] }, label: string) =>
  section.rows.find((r) => r.label === label)?.value

const sectionText = (section: AboutLimitsView[keyof AboutLimitsView]) =>
  [
    section.status?.text ?? "",
    ...section.rows.flatMap((r) => [r.label, r.value]),
    ...section.notes,
  ].join("\n")

const allText = (v: AboutLimitsView) =>
  [v.operation, v.capacity, v.sponsorship].map(sectionText).join("\n")

const CAPACITY_STATES: (CapacityFacts | undefined)[] = [
  undefined,
  { state: "loading" },
  { state: "fresh", observation: dai },
  { state: "fresh", observation: { ...dai, ratePerSecond: 0n } },
  { state: "stale", observation: dai },
  { state: "unavailable" },
  { state: "unavailable", observation: dai },
  { state: "unsupported" },
  { state: "fresh" },
]

const SPONSORSHIP_STATES: SponsorshipFacts[] = [
  { state: "loading" },
  { state: "unavailable" },
  { state: "unsupported" },
  { state: "no-account" },
  { state: "not-subscribed", maxTx: 100, renews: true, refillPeriodSeconds: 86_400 },
  { state: "not-subscribed", maxTx: 1, renews: false },
  { state: "available", uses: 1, renews: true, refillPeriodSeconds: 86_400 },
  { state: "available", uses: 1, renews: false },
  { state: "available", uses: 1 },
  { state: "available", uses: 1, maxTx: 100, renews: true, refillPeriodSeconds: 86_400 },
  { state: "renewal-unknown", maxTx: 100, refillPeriodSeconds: 86_400 },
  { state: "renewal-unknown", maxTx: 100 },
  { state: "spent" },
]

describe("aboutLimitsView per-transaction maximum", () => {
  it("states each supplied maximum with its amount basis and the nominal valuation", () => {
    const { operation } = view({})
    expect(operation.state).toBe("known")
    expect(row(operation, "Per deposit")).toBe("$2,500 sent, incl. fees")
    expect(row(operation, "Per withdrawal")).toBe("$2,500 from balance, incl. fees")
    expect(operation.notes).toContain(
      "The limit counts 1 DAI, USDC or USDT as $1. This is a fixed rate, not a market price.",
    )
    expect(operation.notes).toContain(
      "It does not set what a converted deposit credits or how much capacity it uses.",
    )
  })

  it("keeps a missing or malformed maximum unknown instead of inventing one", () => {
    const partial = view({ product: { deposit: product.deposit } }).operation
    expect(partial.state).toBe("partial")
    expect(row(partial, "Per withdrawal")).toBe("Unavailable")
    expect(partial.notes.some((n) => n.includes("as $1"))).toBe(false)

    const malformed = view({
      product: { deposit: { maximumUsd: "2,500", basis: "sent-including-fees" } },
    })
    expect(malformed.operation.state).toBe("unknown")
    expect(row(malformed.operation, "Per deposit")).toBe("Unavailable")

    const none = view({ product: {} }).operation
    expect(none.state).toBe("unknown")
    expect(none.notes).toEqual([])
    // A valuation with no maximum to apply it to says nothing.
    expect(view({ product: { valuation: product.valuation } }).operation.notes).toEqual([])
  })

  it("scopes the maximum to each transaction, not a day or a balance", () => {
    const text = sectionText(view({}).operation)
    expect(text).toContain("applies to each transaction and does not change over time")
    expect(text).toContain("There is no daily limit and no limit on your balance.")
    // A deposit address is single-use: more funds mean more deposits, each to a new address.
    expect(text).toContain(
      "To deposit more, make separate deposits. Each one uses a new address and pays its own fee.",
    )
    expect(text).toContain(
      "To withdraw more, make separate withdrawals. Each one pays its own fee.",
    )
    expect(text).not.toMatch(/separate transactions|same address/i)
    const depositOnly = sectionText(view({ product: { deposit: product.deposit } }).operation)
    expect(depositOnly).toContain("Each one uses a new address")
    expect(depositOnly).not.toContain("To withdraw more")
  })
})

describe("aboutLimitsView shared capacity", () => {
  it("shows a fresh read in token units, floored, with the injected check time", () => {
    const { capacity } = view({})
    expect(capacity.state).toBe("fresh")
    expect(capacity.status?.text).toBe("Capacity up to date")
    // 1,234.56789 must not round up to .57.
    expect(row(capacity, "Available")).toBe("1,234.56 DAI")
    expect(row(capacity, "Total capacity")).toBe("50,000 DAI")
    expect(row(capacity, "Refill rate")).toBe("34.72 DAI per minute")
    expect(row(capacity, "Last checked")).toBe("time:1000")
    expect(capacity.rows.some((r) => r.value.includes("$"))).toBe(false)
    expect(capacity.canRetry).toBe(false)
  })

  it("keeps 6-decimal precision and never shows a positive rate as zero", () => {
    const usdc = {
      ...dai,
      decimals: 6,
      tokenSymbol: "USDC",
      available: 1_500_000_000n,
      ceiling: 2_000_000_000n,
    }
    const at = (ratePerSecond: bigint) =>
      view({ capacity: { state: "fresh", observation: { ...usdc, ratePerSecond } } }).capacity
    const slow = at(1n)
    expect(row(slow, "Available")).toBe("1,500 USDC")
    expect(row(slow, "Refill rate")).toBe("Less than 0.01 USDC per minute")
    expect(row(at(200n), "Refill rate")).toBe("0.01 USDC per minute")
  })

  it("states the refill model, that withdrawals do not restore it, and no reservation", () => {
    const { notes } = view({}).capacity
    expect(notes).toContain(CAPACITY_DISCLOSURE)
    expect(CAPACITY_DISCLOSURE).toBe(
      "Capacity is shared by everyone and refills continuously. It does not reset at midnight.",
    )
    expect(notes).toContain("Withdrawals do not restore deposit capacity.")
    expect(notes).toContain(CAPACITY_NOT_RESERVED_NOTE)
  })

  it("does not claim a refill when the read shows a zero rate", () => {
    const capacity = view({
      capacity: { state: "fresh", observation: { ...dai, ratePerSecond: 0n } },
    }).capacity
    expect(row(capacity, "Refill rate")).toBe("No automatic refill")
    expect(sectionText(capacity)).not.toContain("refills continuously")
    expect(sectionText(capacity)).toContain("No automatic refill is configured.")
  })

  it("uses the funding panel's figure for the available amount when it is given", () => {
    const capacity = view({
      capacity: { state: "stale", observation: dai, label: "1,234.56 DAI (not current)" },
    }).capacity
    expect(row(capacity, "Available")).toBe("1,234.56 DAI (not current)")
    expect(row(capacity, "Total capacity")).toBe("50,000 DAI")
  })

  it("shows the funding panel's sentence and retry for a current read", () => {
    const low = view({
      capacity: {
        state: "fresh",
        observation: dai,
        notice: "Network capacity is low.",
        offerRetry: false,
      },
    }).capacity
    expect(low.state).toBe("fresh")
    expect(low.status).toEqual({ text: "Network capacity is low.", icon: "alert-triangle" })
    expect(low.canRetry).toBe(false)
    const empty = view({
      capacity: { state: "fresh", observation: dai, notice: CAPACITY_NONE, offerRetry: true },
    }).capacity
    expect(empty.status).toEqual({ text: CAPACITY_NONE, icon: "alert-triangle" })
    expect(empty.canRetry).toBe(true)
    // A stale read keeps its own status: the panel's sentence describes a current read only.
    const stale = view({
      capacity: { state: "stale", observation: dai, notice: CAPACITY_NONE, offerRetry: true },
    }).capacity
    expect(stale.status?.text).toBe("Capacity out of date")
  })

  it("marks a stale read out of date and offers a retry", () => {
    const capacity = view({ capacity: { state: "stale", observation: dai } }).capacity
    expect(capacity.status?.text).toBe("Capacity out of date")
    expect(row(capacity, "Available")).toBe("1,234.56 DAI")
    expect(capacity.canRetry).toBe(true)
  })

  it("never shows amounts for a failed, loading, unsupported or empty read", () => {
    for (const facts of [
      { state: "unavailable", observation: dai },
      { state: "loading", observation: dai },
      { state: "unsupported" },
      { state: "fresh" },
      { state: "stale" },
    ] as CapacityFacts[]) {
      const capacity = view({ capacity: facts }).capacity
      expect(capacity.rows).toEqual([])
      expect(sectionText(capacity)).not.toMatch(/\b0 DAI\b/)
    }
    expect(view({ capacity: { state: "fresh" } }).capacity.state).toBe("unavailable")
    expect(view({ capacity: { state: "unavailable" } }).capacity.status?.text).toBe(
      "Capacity could not be checked.",
    )
    // Unsupported means the wallet cannot read capacity, not that the network has none.
    expect(view({ capacity: { state: "unsupported" } }).capacity.status?.text).toBe(
      "Capacity can't be checked on this network.",
    )
  })

  it("shows only the explanation when no capacity source is connected", () => {
    const { capacity } = aboutLimitsView({ product, sponsorship: { state: "loading" } }, format)
    expect(capacity.state).toBe("general")
    expect(capacity.status).toBeUndefined()
    expect(capacity.rows).toEqual([])
    expect(capacity.canRetry).toBe(false)
    expect(capacity.notes).toEqual([
      CAPACITY_DISCLOSURE,
      "Withdrawals do not restore deposit capacity.",
      CAPACITY_NOT_RESERVED_NOTE,
    ])
  })

  it("offers a retry only when a read failed or went stale", () => {
    const retry = (facts: CapacityFacts) => view({ capacity: facts }).capacity.canRetry
    expect(retry({ state: "loading" })).toBe(false)
    expect(retry({ state: "unsupported" })).toBe(false)
    expect(retry({ state: "unavailable" })).toBe(true)
    expect(retry({ state: "stale", observation: dai })).toBe(true)
  })
})

describe("aboutLimitsView sponsorship allowance", () => {
  const sponsorship = (facts: SponsorshipFacts) => view({ sponsorship: facts }).sponsorship

  it("gives every allowance state its own status text", () => {
    // Variants of one state share its status text; the rows tell them apart.
    const variant = (s: SponsorshipFacts) =>
      (s.state === "available" && (s.renews !== true || s.maxTx !== undefined)) ||
      (s.state === "renewal-unknown" && !s.refillPeriodSeconds) ||
      (s.state === "not-subscribed" && s.maxTx === 1)
    const texts = SPONSORSHIP_STATES.filter((s) => !variant(s)).map(
      (s) => sponsorship(s).status?.text,
    )
    expect(new Set(texts).size).toBe(texts.length)
    expect(texts.every(Boolean)).toBe(true)
  })

  it("shows remaining uses, the configured allowance and its renewal period", () => {
    const available = sponsorship({
      state: "available",
      uses: 3,
      maxTx: 100,
      renews: true,
      refillPeriodSeconds: 86_400,
    })
    expect(available.status?.text).toBe("3 sponsored transactions left")
    expect(row(available, "Allowance")).toBe("100")
    expect(row(available, "Renews")).toBe("When used up, 24 hours after the last renewal")
    expect(available.notes).toContain("It does not reset at midnight.")
    expect(sponsorship({ state: "available", uses: 1 }).status?.text).toBe(
      "1 sponsored transaction left",
    )
    expect(row(sponsorship({ state: "available", uses: 3 }), "Renews")).toBe("Unknown")
  })

  it("splits the spent uses between your transactions and deposit addresses", () => {
    const usage = { yours: 4, depositAddresses: 2 }
    const available = sponsorship({ state: "available", uses: 4, maxTx: 10, usage })
    expect(row(available, "Used by your transactions")).toBe("4")
    expect(row(available, "Used by deposit addresses")).toBe("2")
    expect(
      row(sponsorship({ state: "renewal-unknown", maxTx: 6, usage }), "Used by deposit addresses"),
    ).toBe("2")
    expect(
      row(sponsorship({ state: "available", uses: 4 }), "Used by your transactions"),
    ).toBeUndefined()
  })

  it("does not say the next action renews an allowance that still has uses", () => {
    // The contract spends a remaining use even after the period has passed.
    const text = sectionText(
      sponsorship({ state: "available", uses: 3, renews: true, refillPeriodSeconds: 86_400 }),
    )
    expect(text).not.toMatch(/renews? on your next eligible action/i)
    expect(text).toContain("When used up")
  })

  it("says the first sponsored transaction opens the allowance", () => {
    const opening = sponsorship({
      state: "not-subscribed",
      maxTx: 100,
      renews: true,
      refillPeriodSeconds: 86_400,
    })
    expect(opening.status?.text).toBe("Sponsored transactions not started yet")
    expect(row(opening, "First allowance")).toBe("100")
    expect(row(opening, "Renews")).toBe("When used up, 24 hours after it opened")
    expect(opening.notes).toContain(
      "Your first sponsored transaction opens an allowance of 100 and uses one of them.",
    )
    expect(opening.notes).toContain("It does not reset at midnight.")
    expect(sectionText(opening)).not.toMatch(/no sponsored|used up until|wait until/i)

    const single = sponsorship({ state: "not-subscribed", maxTx: 1, renews: false })
    expect(single.notes).toContain(
      "Your first sponsored transaction opens a one-use allowance and uses it.",
    )
    expect(single.notes).toContain("This allowance does not renew.")
  })

  it("offers a retry only when the allowance read failed", () => {
    for (const facts of SPONSORSHIP_STATES) {
      expect(sponsorship(facts).canRetry).toBe(facts.state === "unavailable")
    }
  })

  it("says a stored zero that may renew is unknown, never used up, and names no time", () => {
    const unknown = sponsorship({
      state: "renewal-unknown",
      maxTx: 100,
      refillPeriodSeconds: 86_400,
    })
    expect(unknown.state).toBe("renewal-unknown")
    expect(unknown.status?.text).toBe("Renewal status unknown")
    expect(unknown.status?.icon).toBe("info-circle")
    expect(row(unknown, "Allowance")).toBe("100")
    expect(row(unknown, "Renews")).toBe("When used up, 24 hours after the last renewal")
    const text = sectionText(unknown)
    // The next eligible action is never held back.
    expect(text).toContain(
      "We can't confirm renewal yet. Your next eligible transaction may start a new allowance.",
    )
    expect(text).not.toMatch(/stored/i)
    expect(text).not.toMatch(/used up until|wait until|next renewal|no sponsored/i)
    expect(unknown.rows.map((r) => r.label)).not.toContain("Next renewal")
  })

  it("says none are left only for an allowance that never renews", () => {
    const spent = sponsorship({ state: "spent" })
    expect(spent.status?.text).toBe("No sponsored transactions left")
    expect(row(spent, "Renews")).toBe("No")
  })

  it("never describes a non-renewing allowance as renewing", () => {
    const nonRenewing: SponsorshipFacts[] = [
      { state: "spent" },
      { state: "available", uses: 1, renews: false },
      { state: "not-subscribed", maxTx: 1, renews: false },
    ]
    for (const facts of nonRenewing) {
      const text = sectionText(sponsorship(facts))
      expect(text).toContain("This allowance does not renew.")
      expect(text).not.toMatch(/renews (on|in|at|after|\d)|next renewal|daily|midnight/i)
    }
  })

  it("states the allowance scope with the allowance sheet's wording", () => {
    for (const facts of SPONSORSHIP_STATES) {
      expect(sponsorship(facts).notes[0]).toBe(ALLOWANCE_SCOPE)
    }
  })
})

describe("aboutLimitsView wording across every state", () => {
  it("never shows the internal ceiling or a daily-reset claim", () => {
    for (const capacity of CAPACITY_STATES) {
      for (const sponsorship of SPONSORSHIP_STATES) {
        const text = allText(view({ capacity, sponsorship }))
        expect(text).not.toMatch(/2,?583/)
        const withoutNegation = text.replaceAll("It does not reset at midnight.", "")
        expect(withoutNegation).not.toMatch(
          /midnight|daily reset|resets? (daily|every day|each day)|tomorrow|per day/i,
        )
      }
    }
  })
})
