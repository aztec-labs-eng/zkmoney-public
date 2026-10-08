import { describe, expect, it } from "vitest"
import type { Address } from "viem"
import type { PortalCapacitySnapshot, SipaPortalTerms } from "@obsidion/sdk"
import { SOURCE_OPERATION_CAP } from "@obsidion/sdk"

import {
  evaluateCapacityEligibility,
  type RequiredCredit,
} from "../../src/oxide/portalCapacityEligibility"
import { portalCapacityKey, type PortalCapacityState } from "../../src/oxide/portalCapacityStore"
import { sipaProcessingReason, sipaRequiredCredit } from "../../src/oxide/sipaProcessingReason"
import {
  isAwaitingSweep,
  nextSipaSweepBlocker,
  sipaReasonShown,
  sipaSweepAllowed,
  type SipaProcessingReason,
} from "../../src/core/services/deposits/sipaProcessing"
import { STUCK_SWEEP_MS } from "../../src/core/services/deposits/sipaStuck"
import type { SIPADepositRecord } from "../../src/core/services/deposits/SIPADepositStore"

const E18 = 10n ** 18n
const DAI = `0x${"da".repeat(20)}` as Address
const USDC = `0x${"0c".repeat(20)}` as Address
const PORTAL = `0x${"11".repeat(20)}` as Address
const KEY = portalCapacityKey({ chainId: 1, portal: PORTAL, token: DAI })
const T = 1_000_000

const terms: SipaPortalTerms = {
  portal: PORTAL,
  token: DAI,
  depositFee: 1n * E18,
  fpcFundingCut: E18 / 2n,
}

const deposit = (over: Partial<SIPADepositRecord> = {}) => ({
  amount: "100",
  tokenAddress: DAI,
  tokenDecimals: 18,
  ...over,
})

const snapshot = (over: Partial<PortalCapacitySnapshot> = {}): PortalCapacitySnapshot => ({
  chainId: 1,
  portal: PORTAL,
  token: DAI,
  decimals: 18,
  blockNumber: 10n,
  blockTimestamp: 1_000n,
  rateAtomicPerSecond: E18,
  globalLimitAtomic: 50_000n * E18,
  availableAtomic: 500n * E18,
  ...over,
})

const fresh = (over: Partial<PortalCapacitySnapshot> = {}): PortalCapacityState => ({
  status: "fresh",
  key: KEY,
  snapshot: snapshot(over),
  fetchedAt: T,
})

const known = (atomic: bigint): RequiredCredit => ({
  status: "known",
  atomic,
  token: DAI,
  decimals: 18,
})

const reason = (state: PortalCapacityState, required: RequiredCredit) =>
  sipaProcessingReason(
    evaluateCapacityEligibility({
      state,
      required,
      operationCap: SOURCE_OPERATION_CAP,
      now: T + 1,
    }),
    T + 1,
  )

describe("sipaRequiredCredit", () => {
  it("takes the deposit fee and the original portal's cut off the gross", () => {
    expect(sipaRequiredCredit(deposit(), terms)).toEqual(known(100n * E18 - E18 - E18 / 2n))
  })

  it("uses the portal's own cut, not the fee stored on the record", () => {
    const stored = deposit({ fee: (5n * E18).toString(), fpcFundingCut: (4n * E18).toString() })
    expect(sipaRequiredCredit(stored, terms)).toEqual(known(98n * E18 + E18 / 2n))
  })

  it("takes a registration's signed fee instead of the deposit fee", () => {
    const registration = deposit({ intent: "registration", registrationFee: (3n * E18).toString() })
    expect(sipaRequiredCredit(registration, terms)).toEqual(known(96n * E18 + E18 / 2n))
  })

  it("is unknown for a registration without its fee or with a fee below the deposit fee", () => {
    expect(sipaRequiredCredit(deposit({ intent: "registration" }), terms)).toEqual({
      status: "unknown",
    })
    const low = deposit({ intent: "registration", registrationFee: (E18 / 2n).toString() })
    expect(sipaRequiredCredit(low, terms)).toEqual({ status: "unknown" })
  })

  it("is unknown for a token the sweep converts", () => {
    expect(sipaRequiredCredit(deposit({ tokenAddress: USDC, tokenDecimals: 6 }), terms)).toEqual({
      status: "unknown",
    })
  })

  it("matches the settlement token regardless of address case", () => {
    const checksummed = deposit({ tokenAddress: DAI.toUpperCase().replace("0X", "0x") as Address })
    expect(sipaRequiredCredit(checksummed, terms).status).toBe("known")
  })

  it("is unknown without a token, decimals, a parseable amount or a positive credit", () => {
    for (const record of [
      deposit({ tokenAddress: undefined }),
      deposit({ tokenDecimals: undefined }),
      deposit({ amount: "not a number" }),
      deposit({ amount: "1.5" }),
    ]) {
      expect(sipaRequiredCredit(record, terms)).toEqual({ status: "unknown" })
    }
  })
})

describe("sipaProcessingReason", () => {
  it("waits for processing when the credit fits exactly", () => {
    expect(reason(fresh(), known(500n * E18))).toEqual({
      kind: "processing",
      availableAtomic: 500n * E18,
      decimals: 18,
      observedAt: T,
    })
  })

  it("waits for capacity one base unit short, with both amounts and no estimate", () => {
    expect(reason(fresh(), known(500n * E18 + 1n))).toEqual({
      kind: "capacity",
      requiredAtomic: 500n * E18 + 1n,
      availableAtomic: 500n * E18,
      refill: { status: "unknown" },
      decimals: 18,
      observedAt: T,
    })
  })

  it("says no refill is configured at rate zero", () => {
    const r = reason(fresh({ rateAtomicPerSecond: 0n, availableAtomic: 0n }), known(E18))
    expect(r).toMatchObject({ kind: "capacity", refill: { status: "none" } })
  })

  it("names a credit above the bucket ceiling, without a refill", () => {
    const r = reason(fresh({ globalLimitAtomic: 1_000n * E18 }), known(1_000n * E18 + 1n))
    expect(r).toEqual({
      kind: "ceiling",
      requiredAtomic: 1_000n * E18 + 1n,
      ceilingAtomic: 1_000n * E18,
      decimals: 18,
      observedAt: T,
    })
  })

  it("names a credit above the operation cap even before capacity is read", () => {
    const loading: PortalCapacityState = { status: "loading", key: KEY }
    expect(reason(loading, known(SOURCE_OPERATION_CAP.sourceAtomic + 1n))).toEqual({
      kind: "operation-cap",
      observedAt: T + 1,
    })
  })

  it("checks while the first read runs", () => {
    expect(reason({ status: "loading", key: KEY }, known(E18))).toEqual({ kind: "checking" })
  })

  it("never reports capacity from a stale, failed or unsupported read", () => {
    const stale: PortalCapacityState = {
      status: "stale",
      key: KEY,
      reason: "age",
      snapshot: snapshot({ availableAtomic: 0n }),
      fetchedAt: T - 60_000,
    }
    expect(reason(stale, known(E18))).toEqual({
      kind: "unavailable",
      cause: "capacity-unread",
      last: { availableAtomic: 0n, decimals: 18, observedAt: T - 60_000 },
    })
    const failed: PortalCapacityState = {
      status: "unavailable",
      key: KEY,
      error: new Error("rpc"),
      failedAt: T,
    }
    expect(reason(failed, known(E18))).toEqual({ kind: "unavailable", cause: "capacity-unread" })
    const unsupported: PortalCapacityState = {
      status: "unsupported",
      key: KEY,
      reason: "no-capacity-getters",
      detail: "",
    }
    expect(reason(unsupported, known(E18))).toEqual({
      kind: "unavailable",
      cause: "capacity-unread",
    })
  })

  it("draws no fit from an unknown credit, however much capacity there is", () => {
    const full = fresh({ availableAtomic: 50_000n * E18 })
    expect(reason(full, { status: "unknown" })).toEqual({
      kind: "unavailable",
      cause: "amount-unknown",
      availableAtomic: 50_000n * E18,
      decimals: 18,
      observedAt: T,
    })
  })

  it("confirms a wait for an unknown credit only at zero capacity", () => {
    expect(reason(fresh({ availableAtomic: 0n }), { status: "unknown" })).toEqual({
      kind: "capacity",
      availableAtomic: 0n,
      refill: { status: "unknown" },
      decimals: 18,
      observedAt: T,
    })
  })

  it("reports an unknown portal as unavailable", () => {
    expect(sipaProcessingReason(undefined, T)).toEqual({
      kind: "unavailable",
      cause: "portal-unknown",
    })
  })
})

describe("the manual-sweep blocker", () => {
  const short: SipaProcessingReason = {
    kind: "capacity",
    requiredAtomic: 2n,
    availableAtomic: 1n,
    refill: { status: "unknown" },
    decimals: 18,
    observedAt: T,
  }
  const fitsAt = (observedAt: number): SipaProcessingReason => ({
    kind: "processing",
    availableAtomic: 5n,
    decimals: 18,
    observedAt,
  })

  it("is set by a confirmed shortfall and survives a missing, stale or pending read", () => {
    const blocker = nextSipaSweepBlocker(undefined, short)
    expect(blocker).toEqual({ kind: "capacity", observedAt: T })
    for (const next of [
      { kind: "unavailable", cause: "capacity-unread" },
      { kind: "unavailable", cause: "portal-unknown" },
      { kind: "checking" },
    ] as SipaProcessingReason[]) {
      const kept = nextSipaSweepBlocker(blocker, next)
      expect(kept).toBe(blocker)
      expect(sipaSweepAllowed({ reason: next, blocker: kept })).toBe(false)
    }
  })

  it("clears only on a fit read after the blocker", () => {
    const blocker = nextSipaSweepBlocker(undefined, short)
    expect(nextSipaSweepBlocker(blocker, fitsAt(T))).toBe(blocker)
    expect(nextSipaSweepBlocker(blocker, fitsAt(T + 1))).toBeUndefined()
    expect(sipaSweepAllowed({ reason: fitsAt(T + 1) })).toBe(true)
  })

  it("clears a zero-capacity blocker on an unknown credit once capacity is above zero", () => {
    const zero = nextSipaSweepBlocker(undefined, {
      kind: "capacity",
      availableAtomic: 0n,
      refill: { status: "unknown" },
      decimals: 18,
      observedAt: T,
    })
    expect(zero).toEqual({ kind: "capacity", observedAt: T, zeroCapacity: true })
    const later: SipaProcessingReason = {
      kind: "unavailable",
      cause: "amount-unknown",
      availableAtomic: 1n,
      decimals: 18,
      observedAt: T + 1,
    }
    expect(nextSipaSweepBlocker(zero, later)).toBeUndefined()
    expect(nextSipaSweepBlocker(zero, { ...later, observedAt: T })).toBe(zero)
    expect(nextSipaSweepBlocker(zero, { ...later, availableAtomic: 0n })).toBe(zero)
    const known = nextSipaSweepBlocker(undefined, short)
    expect(nextSipaSweepBlocker(known, later)).toBe(known)
  })

  it("keeps a ceiling or operation-cap blocker", () => {
    const ceiling = nextSipaSweepBlocker(undefined, {
      kind: "ceiling",
      requiredAtomic: 2n,
      ceilingAtomic: 1n,
      decimals: 18,
      observedAt: T,
    })
    expect(ceiling).toEqual({ kind: "ceiling", observedAt: T })
    const cap = nextSipaSweepBlocker(undefined, { kind: "operation-cap", observedAt: T })
    expect(cap).toEqual({ kind: "operation-cap", observedAt: T })
    expect(nextSipaSweepBlocker(cap, { kind: "checking" })).toBe(cap)
  })

  it("allows the sweep when no blocker is known, whatever the read", () => {
    expect(sipaSweepAllowed(undefined)).toBe(true)
    expect(sipaSweepAllowed({ reason: { kind: "unavailable", cause: "capacity-unread" } })).toBe(
      true,
    )
  })
})

describe("isAwaitingSweep", () => {
  const base = {
    phase: "sweeping" as const,
    amount: "10",
    sweepTxHash: undefined,
    inboxIndex: undefined,
    netAmount: undefined,
  }

  it("holds for funded, broadcast and sweeping deposits with no sweep seen", () => {
    for (const phase of ["funded", "broadcast", "sweeping"] as const) {
      expect(isAwaitingSweep({ ...base, phase })).toBe(true)
    }
  })

  it("excludes unfunded, swept, settled and recoverable deposits", () => {
    expect(isAwaitingSweep({ ...base, phase: "broadcast", amount: "0" })).toBe(false)
    expect(isAwaitingSweep({ ...base, sweepTxHash: "0x01" })).toBe(false)
    expect(isAwaitingSweep({ ...base, inboxIndex: "3" })).toBe(false)
    expect(isAwaitingSweep({ ...base, netAmount: "9" })).toBe(false)
    for (const phase of [
      "resolved",
      "funding",
      "pendingClaim",
      "claimed",
      "recoverable",
      "recovered",
      "failed",
    ] as const) {
      expect(isAwaitingSweep({ ...base, phase })).toBe(false)
    }
  })
})

describe("sipaReasonShown", () => {
  const fresh = { phase: "sweeping" as const, startTime: T, sweepTxHash: undefined }
  const later = T + STUCK_SWEEP_MS

  it("says a confirmed or remembered blocker at once", () => {
    const short: SipaProcessingReason = {
      kind: "capacity",
      requiredAtomic: 2n,
      availableAtomic: 1n,
      refill: { status: "unknown" },
      decimals: 18,
      observedAt: T,
    }
    expect(sipaReasonShown({ reason: short }, fresh, T)).toBe(true)
    expect(sipaReasonShown({ reason: { kind: "operation-cap", observedAt: T } }, fresh, T)).toBe(
      true,
    )
    const remembered = {
      reason: { kind: "unavailable" as const, cause: "capacity-unread" as const },
      blocker: { kind: "capacity" as const, observedAt: T },
    }
    expect(sipaReasonShown(remembered, fresh, T)).toBe(true)
  })

  it("holds any other reason until the stuck clock, so a fresh deposit is not called delayed", () => {
    for (const reason of [
      { kind: "processing", availableAtomic: 1n, decimals: 18, observedAt: T },
      { kind: "checking" },
    ] as SipaProcessingReason[]) {
      expect(sipaReasonShown({ reason }, fresh, later - 1)).toBe(false)
      expect(sipaReasonShown({ reason }, fresh, later)).toBe(true)
    }
    expect(sipaReasonShown(undefined, fresh, later)).toBe(false)
  })

  it("never states an unavailable reason without a blocker", () => {
    for (const reason of [
      {
        kind: "unavailable",
        cause: "amount-unknown",
        availableAtomic: 1n,
        decimals: 18,
        observedAt: T,
      },
      { kind: "unavailable", cause: "capacity-unread" },
      { kind: "unavailable", cause: "portal-unknown" },
    ] as SipaProcessingReason[]) {
      expect(sipaReasonShown({ reason }, fresh, later)).toBe(false)
    }
  })
})
