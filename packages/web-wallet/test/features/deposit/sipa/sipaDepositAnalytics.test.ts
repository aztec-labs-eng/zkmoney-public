import { describe, expect, it } from "vitest"
import type { SipaDeposit } from "@obsidion/front-core"
import {
  createClaimSweepReporter,
  createSyncFailureReporter,
} from "../../../../src/features/deposit/sipaTasks"

function record(over: Partial<SipaDeposit>): SipaDeposit {
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
  } as SipaDeposit
}

describe("createClaimSweepReporter", () => {
  const SINCE = 100_000
  // record() settles at endTime 61_000 — before SINCE, so it is history.
  const history = record({ sipaAddress: "0xhistory" })
  const settledNow = record({ sipaAddress: "0xnew", startTime: SINCE, endTime: SINCE + 5_000 })

  it("reports a claim that settles after `since`, exactly once", () => {
    const report = createClaimSweepReporter(SINCE)
    expect(report([history, record({ sipaAddress: "0xpending", phase: "pendingClaim" })])).toEqual(
      [],
    )
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

describe("createSyncFailureReporter", () => {
  it("reports a run of failing syncs once, and again once a clean sync comes between", () => {
    const report = createSyncFailureReporter()
    expect([1, 1, 1, 0, 2].map(report)).toEqual([true, false, false, false, true])
  })
})
