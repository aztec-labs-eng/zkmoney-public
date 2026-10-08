import { describe, expect, it } from "vitest"
import {
  deriveAllowanceState,
  depositTokenValuation,
  NOMINAL_USD_VALUATION,
  type AllowanceSnapshot,
  type PortalCapacityState,
} from "@obsidion/front-core"
import type { ClaimFpcAllowance } from "@obsidion/sdk"
import type { DepositTokenOption } from "../src/features/deposit/loadDepositFacts"
import {
  capacityFacts,
  productLimitFacts,
  sponsorshipFacts,
} from "../src/features/limits/aboutLimitsFacts"
import { aboutLimitsView } from "../src/features/limits/aboutLimitsView"

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7"
const OTHER = "0x1111111111111111111111111111111111111111"
const option = (symbol: string, address?: `0x${string}`): DepositTokenOption => ({
  symbol,
  address,
  decimals: 18,
  icon: "",
})
// The deposit screen's rule: a token without an address is the manifest token.
const valuedOn = (chainId: number, portalToken: string) => (token: DepositTokenOption) =>
  depositTokenValuation({ chainId, portalToken, token: token.address ?? portalToken })

describe("productLimitFacts", () => {
  it("states the published maximum for each operation with its amount basis", () => {
    expect(productLimitFacts({ tokens: [] })).toEqual({
      deposit: { maximumUsd: "2500", basis: "sent-including-fees" },
      withdrawal: { maximumUsd: "2500", basis: "debited-including-fees" },
    })
  })

  it("lists the tokens the nominal rate covers, matched by address", () => {
    const tokens = [option("DAI"), option("USDC", USDC), option("USDT", USDT), option("DAI", OTHER)]
    expect(productLimitFacts({ tokens, valuationOf: valuedOn(1, DAI) }).valuation).toEqual({
      tokens: ["DAI", "USDC", "USDT"],
    })
    // Off mainnet only the portal's own token is accepted, whatever the other options are called.
    expect(productLimitFacts({ tokens, valuationOf: valuedOn(11155111, OTHER) }).valuation).toEqual(
      { tokens: ["DAI", "DAI"] },
    )
  })

  it("leaves the valuation unknown when no token can be valued", () => {
    expect(productLimitFacts({ tokens: [option("DAI")] }).valuation).toBeUndefined()
    const none = productLimitFacts({ tokens: [option("X", OTHER)], valuationOf: valuedOn(1, DAI) })
    expect(none.valuation).toBeUndefined()
  })

  it("hides the list when a token has any valuation other than the nominal rate", () => {
    const valuationOf = (token: DepositTokenOption) =>
      token.symbol === "USDC"
        ? { source: "market", usdPerToken: { numerator: 99n, denominator: 100n } }
        : NOMINAL_USD_VALUATION
    const facts = productLimitFacts({ tokens: [option("DAI"), option("USDC", USDC)], valuationOf })
    expect(facts.valuation).toBeUndefined()
  })
})

const allowance = (overrides: Partial<ClaimFpcAllowance> = {}): ClaimFpcAllowance => ({
  subscribed: true,
  uses: 0,
  maxTx: 100,
  refillPeriod: 86_400,
  ...overrides,
})

const ready = (read: ClaimFpcAllowance): AllowanceSnapshot => ({
  status: "ready",
  scope: "account|sandbox",
  read: { fpcAddress: "0xfpc", railId: 1, allowance: read },
  state: deriveAllowanceState(read),
  refreshing: false,
})

describe("sponsorshipFacts", () => {
  it("maps a pending or failed read without inventing a state", () => {
    expect(sponsorshipFacts({ status: "signed-out" })).toEqual({ state: "loading" })
    expect(sponsorshipFacts({ status: "loading", scope: "s" })).toEqual({ state: "loading" })
    expect(
      sponsorshipFacts({ status: "unavailable", scope: "s", error: new Error("rpc") }),
    ).toEqual({
      state: "unavailable",
    })
  })

  it("maps each allowance state, with the rail's configured allowance and renewal period", () => {
    expect(sponsorshipFacts(ready(allowance({ subscribed: false })))).toEqual({
      state: "not-subscribed",
      maxTx: 100,
      renews: true,
      refillPeriodSeconds: 86_400,
    })
    expect(sponsorshipFacts(ready(allowance({ uses: 3 })))).toEqual({
      state: "available",
      uses: 3,
      maxTx: 100,
      renews: true,
      refillPeriodSeconds: 86_400,
    })
    expect(sponsorshipFacts(ready(allowance()))).toEqual({
      state: "renewal-unknown",
      maxTx: 100,
      refillPeriodSeconds: 86_400,
    })
    expect(sponsorshipFacts(ready(allowance({ refillPeriod: 0 })))).toEqual({ state: "spent" })
  })

  it("states no renewal time for a stored zero that may renew", () => {
    const view = aboutLimitsView(
      { product: {}, sponsorship: sponsorshipFacts(ready(allowance())) },
      { time: String },
    ).sponsorship
    expect(view.status?.text).toBe("Renewal status unknown")
    expect(view.rows.map((row) => row.label)).not.toContain("Next renewal")
    expect([...view.rows.map((row) => row.value), ...view.notes].join(" ")).not.toMatch(
      /\d{1,2}:\d{2}|countdown|in about|midnight reset/i,
    )
  })
})

describe("capacityFacts", () => {
  const key = { chainId: 1, portal: "0xportal", token: DAI } as PortalCapacityState["key"]
  const snapshot = {
    chainId: 1,
    portal: "0xportal",
    token: DAI,
    decimals: 18,
    blockNumber: 9n,
    blockTimestamp: 1_000n,
    rateAtomicPerSecond: 5n,
    globalLimitAtomic: 50_000n * 10n ** 18n,
    availableAtomic: 1_234_567n * 10n ** 15n,
  } as Extract<PortalCapacityState, { status: "fresh" }>["snapshot"]

  it("maps a read with its values and the funding panel's figure", () => {
    const fresh = capacityFacts({ status: "fresh", key, snapshot, fetchedAt: 42 }, "DAI")
    expect(fresh).toEqual({
      state: "fresh",
      observation: {
        available: snapshot.availableAtomic,
        ceiling: snapshot.globalLimitAtomic,
        ratePerSecond: 5n,
        decimals: 18,
        tokenSymbol: "DAI",
        observedAt: 42,
      },
      label: "1,234.56 DAI",
      notice: undefined,
      offerRetry: undefined,
    })
    const panel = { statusText: "Network capacity is low.", offerRetry: false }
    expect(
      capacityFacts({ status: "fresh", key, snapshot, fetchedAt: 42 }, "DAI", panel),
    ).toMatchObject({ notice: "Network capacity is low.", offerRetry: false })
    const stale = capacityFacts(
      { status: "stale", key, snapshot, fetchedAt: 42, reason: "age" },
      "DAI",
    )
    expect(stale.state).toBe("stale")
    expect(stale.label).toBe("1,234.56 DAI (not current)")
  })

  it("keeps a pending, failed or unsupported read free of amounts", () => {
    expect(capacityFacts(undefined, "DAI")).toEqual({ state: "loading" })
    expect(capacityFacts({ status: "loading", key }, "DAI")).toEqual({ state: "loading" })
    const failed = capacityFacts(
      {
        status: "unavailable",
        key,
        error: new Error("rpc"),
        failedAt: 1,
        lastSnapshot: snapshot,
        lastFetchedAt: 1,
      },
      "DAI",
    )
    expect(failed).toEqual({ state: "unavailable" })
    expect(
      capacityFacts({ status: "unsupported", key, reason: "token-mismatch", detail: "x" }, "DAI"),
    ).toEqual({ state: "unsupported" })
  })
})
