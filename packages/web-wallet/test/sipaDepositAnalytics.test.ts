import { describe, expect, it } from "vitest"
import type { SIPADepositRecord } from "@obsidion/front-core"
import { failureCode } from "../src/lib/analytics"
import {
  createClaimSweepReporter,
  createSyncFailureReporter,
  newlyClaimedRecords,
} from "../src/features/deposit/useSipaDeposits"

function record(over: Partial<SIPADepositRecord>): SIPADepositRecord {
  return {
    sipaAddress: "0xaaaa",
    recipientL2Address: "0x1",
    messageSecret: "0x2",
    recipientHash: "0x3",
    recoveryAddress: "0x4",
    l1ChainId: 31337,
    amount: "5",
    tokenSymbol: "DAI",
    phase: "claimed",
    startTime: 1_000,
    endTime: 61_000,
    ...over,
  } as SIPADepositRecord
}

describe("newlyClaimedRecords", () => {
  it("reports a claim exactly once across repeated snapshots", () => {
    const seen = new Set<string>()
    const snapshot = [record({})]
    expect(newlyClaimedRecords(snapshot, seen)).toHaveLength(1)
    expect(newlyClaimedRecords(snapshot, seen)).toHaveLength(0)
  })

  it("ignores non-terminal phases and pre-seeded history", () => {
    const seen = new Set<string>(["0xold"])
    const snapshot = [
      record({ sipaAddress: "0xold" }),
      record({ sipaAddress: "0xpending", phase: "pendingClaim" }),
      record({ sipaAddress: "0xnew" }),
    ]
    const fresh = newlyClaimedRecords(snapshot, seen)
    expect(fresh.map((r) => r.sipaAddress)).toEqual(["0xnew"])
  })
})

describe("createClaimSweepReporter", () => {
  const SINCE = 100_000
  // record() settles at endTime 61_000 — before SINCE, so it is history.
  const history = record({ sipaAddress: "0xhistory" })
  const settledNow = record({ sipaAddress: "0xnew", startTime: SINCE, endTime: SINCE + 5_000 })

  // The gateway delivers an empty list first and the loaded history second, so the second
  // delivery must not read as live claims.
  it("ignores history whenever it arrives", () => {
    const report = createClaimSweepReporter(SINCE)
    expect(report([])).toEqual([])
    expect(report([history])).toEqual([])
  })

  it("reports a claim that settles after `since`, exactly once", () => {
    const report = createClaimSweepReporter(SINCE)
    report([history])
    expect(report([history, settledNow]).map((r) => r.sipaAddress)).toEqual(["0xnew"])
    expect(report([history, settledNow])).toEqual([])
  })

  it("re-reports nothing on a remount", () => {
    createClaimSweepReporter(SINCE)([history, settledNow])
    // A later mount sees both as already settled.
    expect(createClaimSweepReporter(SINCE + 10_000)([history, settledNow])).toEqual([])
  })

  it("treats a claimed record with no endTime as history", () => {
    const report = createClaimSweepReporter(SINCE)
    expect(report([record({ sipaAddress: "0xnoend", endTime: undefined })])).toEqual([])
  })
})

describe("deposit failure codes", () => {
  it("labels a stale-identity resolve without echoing the tag", () => {
    expect(failureCode(new Error("execution reverted: UserNotFound(alice)"))).toBe(
      "user_not_registered",
    )
  })

  it("labels a locked-session resolve", () => {
    expect(
      failureCode(new Error("no account for this session — enter with your passkey first")),
    ).toBe("wallet_locked")
  })
})

describe("createSyncFailureReporter", () => {
  it("reports a run of failing syncs once", () => {
    const report = createSyncFailureReporter()
    expect([report(1), report(1), report(1)]).toEqual([true, false, false])
  })

  it("reports again once a clean sync comes between", () => {
    const report = createSyncFailureReporter()
    expect(report(1)).toBe(true)
    expect(report(0)).toBe(false)
    expect(report(2)).toBe(true)
  })
})
