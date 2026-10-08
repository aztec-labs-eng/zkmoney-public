import { describe, expect, it } from "vitest"
import type { OperationCapFact, PortalCapacitySnapshot } from "@obsidion/sdk"
import {
  evaluateCapacityEligibility,
  isCapacityAffirmative,
  type RequiredCredit,
} from "../../src/oxide/portalCapacityEligibility"
import type { PortalCapacityKey, PortalCapacityState } from "../../src/oxide/portalCapacityStore"

const E18 = 10n ** 18n
const NOW = Date.UTC(2026, 8, 25, 12)
const KEY: PortalCapacityKey = {
  chainId: 1,
  portal: `0x${"aa".repeat(20)}`,
  token: `0x${"bb".repeat(20)}`,
}
const CAP: OperationCapFact = { status: "unverified", sourceAtomic: 2_583n * E18 }

const snapshot = (over: Partial<PortalCapacitySnapshot> = {}): PortalCapacitySnapshot => ({
  chainId: 1,
  portal: KEY.portal,
  token: KEY.token,
  decimals: 18,
  blockNumber: 10n,
  blockTimestamp: BigInt(NOW / 1000),
  rateAtomicPerSecond: 578_703_703_703_703n,
  globalLimitAtomic: 50_000n * E18,
  availableAtomic: 50_000n * E18,
  ...over,
})
const fresh = (over: Partial<PortalCapacitySnapshot> = {}): PortalCapacityState => ({
  status: "fresh",
  key: KEY,
  snapshot: snapshot(over),
  fetchedAt: NOW,
})
const amount = (atomic: bigint, decimals = 18, token = KEY.token): RequiredCredit => ({
  status: "known",
  atomic,
  token,
  decimals,
})
const evaluate = (state: PortalCapacityState, required: RequiredCredit, now = NOW) =>
  evaluateCapacityEligibility({ state, required, operationCap: CAP, now })

describe("evaluateCapacityEligibility", () => {
  it("fits at exactly the available amount and is short by one base unit above it", () => {
    const state = fresh({ availableAtomic: 500n * E18 })
    expect(evaluate(state, amount(500n * E18))).toMatchObject({
      kind: "fits",
      requiredAtomic: 500n * E18,
    })
    expect(evaluate(state, amount(500n * E18 + 1n))).toMatchObject({
      kind: "exceeds-available",
      shortfallAtomic: 1n,
    })
  })

  it("blocks a 2,000 credit against 500 of capacity and reports the shortfall", () => {
    const result = evaluate(fresh({ availableAtomic: 500n * E18 }), amount(2_000n * E18))
    expect(result).toMatchObject({
      kind: "exceeds-available",
      requiredAtomic: 2_000n * E18,
      shortfallAtomic: 1_500n * E18,
      snapshot: { availableAtomic: 500n * E18 },
      fetchedAt: NOW,
    })
    expect(isCapacityAffirmative(result)).toBe(false)
  })

  it("offers no refill time without a supported calculation, and none at rate zero", () => {
    expect(evaluate(fresh({ availableAtomic: 0n }), amount(1n))).toMatchObject({
      kind: "exceeds-available",
      estimate: { status: "unsupported" },
    })
    expect(
      evaluate(fresh({ availableAtomic: 0n, rateAtomicPerSecond: 0n }), amount(1n)),
    ).toMatchObject({
      kind: "exceeds-available",
      estimate: { status: "none" },
    })
  })

  it("flags low capacity below one operation cap, using the ceiling when it is smaller", () => {
    expect(evaluate(fresh(), amount(1n))).toMatchObject({ kind: "fits", low: false })
    expect(evaluate(fresh({ availableAtomic: CAP.sourceAtomic }), amount(1n))).toMatchObject({
      low: false,
    })
    expect(evaluate(fresh({ availableAtomic: CAP.sourceAtomic - 1n }), amount(1n))).toMatchObject({
      kind: "fits",
      low: true,
    })
    const smallBucket = { globalLimitAtomic: 1_000n * E18 }
    expect(
      evaluate(fresh({ ...smallBucket, availableAtomic: 1_000n * E18 }), amount(1n)),
    ).toMatchObject({
      low: false,
    })
    expect(
      evaluate(fresh({ ...smallBucket, availableAtomic: 999n * E18 }), amount(1n)),
    ).toMatchObject({
      low: true,
    })
  })

  it("shows capacity without a fit claim when the amount is unknown", () => {
    expect(evaluate(fresh({ availableAtomic: 0n }), { status: "unknown" })).toMatchObject({
      kind: "amount-unknown",
      zero: true,
      low: true,
      snapshot: { availableAtomic: 0n },
      fetchedAt: NOW,
    })
    expect(evaluate(fresh(), { status: "unknown" })).toMatchObject({
      kind: "amount-unknown",
      zero: false,
      low: false,
    })
    expect(evaluate(fresh(), amount(0n)).kind).toBe("amount-unknown")
  })

  it("never offers a wait for an amount above the bucket ceiling", () => {
    const result = evaluate(
      fresh({ globalLimitAtomic: 1_000n * E18, availableAtomic: 10n * E18 }),
      amount(1_000n * E18 + 1n),
    )
    expect(result).toMatchObject({ kind: "exceeds-ceiling", requiredAtomic: 1_000n * E18 + 1n })
    expect(result).not.toHaveProperty("estimate")
  })

  it("checks the unverified operation cap before and without a capacity read", () => {
    expect(evaluate(fresh(), amount(CAP.sourceAtomic)).kind).toBe("fits")
    const over = evaluate({ status: "loading", key: KEY }, amount(CAP.sourceAtomic + 1n))
    expect(over).toEqual({
      kind: "exceeds-operation-cap",
      requiredAtomic: CAP.sourceAtomic + 1n,
      operationCap: CAP,
    })
  })

  it("refuses an amount in another token or with other decimals instead of converting it", () => {
    expect(evaluate(fresh(), amount(1n, 18, `0x${"cc".repeat(20)}`))).toMatchObject({
      kind: "unsupported",
      reason: "amount-token-mismatch",
    })
    expect(evaluate(fresh({ decimals: 18 }), amount(1_000_000n, 6))).toMatchObject({
      kind: "unsupported",
      reason: "amount-decimals-mismatch",
    })
    expect(
      evaluate(fresh({ decimals: 6, availableAtomic: 2_000_000n }), amount(2_000_000n, 6)).kind,
    ).toBe("fits")
  })

  it("never affirms a fresh state that has aged past the stale limit", () => {
    const state = fresh()
    expect(evaluate(state, amount(1n), NOW + 29_999).kind).toBe("fits")
    const aged = evaluate(state, amount(1n), NOW + 30_000)
    expect(aged).toMatchObject({ kind: "stale", reason: "age", fetchedAt: NOW })
    expect(isCapacityAffirmative(aged)).toBe(false)
    expect(
      evaluateCapacityEligibility({
        state,
        required: amount(1n),
        operationCap: CAP,
        now: NOW + 5_000,
        staleAfterMs: 5_000,
      }).kind,
    ).toBe("stale")
  })

  it("passes loading, stale, unavailable and unsupported states through without a fit claim", () => {
    const last = snapshot({ availableAtomic: 7n })
    const cases: [PortalCapacityState, string][] = [
      [{ status: "loading", key: KEY }, "checking"],
      [
        {
          status: "stale",
          key: KEY,
          snapshot: last,
          fetchedAt: NOW,
          reason: "head",
          head: { cause: "old", blockAgeMs: 90_000 },
        },
        "stale",
      ],
      [
        {
          status: "unavailable",
          key: KEY,
          error: new Error("x"),
          failedAt: NOW,
          lastSnapshot: last,
          lastFetchedAt: NOW - 1,
        },
        "unavailable",
      ],
      [{ status: "unsupported", key: KEY, reason: "chain-mismatch", detail: "d" }, "unsupported"],
    ]
    for (const [state, kind] of cases) {
      const result = evaluate(state, amount(1n))
      expect(result.kind).toBe(kind)
      expect(isCapacityAffirmative(result)).toBe(false)
    }
    expect(evaluate(cases[1][0], { status: "unknown" })).toEqual({
      kind: "stale",
      reason: "head",
      head: { cause: "old", blockAgeMs: 90_000 },
      snapshot: last,
      fetchedAt: NOW,
    })
    expect(evaluate(cases[2][0], { status: "unknown" })).toMatchObject({
      kind: "unavailable",
      lastSnapshot: { availableAtomic: 7n },
      lastFetchedAt: NOW - 1,
    })
  })
})
