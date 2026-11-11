import { describe, expect, it } from "vitest"
import {
  createOwedClaims,
  createWithdrawFunnel,
  createWithdrawals,
  memoryBackend,
  openDatabase,
  startRuntime,
  type OnNetwork,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { withdrawReports } from "../../src/app/withdrawReports"
import { sessions } from "../../../front-core/test/engine/taskTable"

const LINK = `0x${"11".repeat(32)}`

const burn = (localId: string, over: Partial<WithdrawalRecord> = {}) =>
  ({
    localId,
    networkId: "0xnet",
    recipient: `0x${"e1".repeat(20)}`,
    recipientProvenance: "saved-recipient",
    amount: "10",
    tokenSymbol: "DAI",
    phase: "finalizing_l1",
    startTime: 1_000,
    phaseEnteredAt: 2_000,
    ...over,
  } as OnNetwork<WithdrawalRecord>)

describe("withdrawReports", () => {
  it("reports the session's withdrawals once read, and again as they change", async () => {
    const backend = memoryBackend()
    const db = openDatabase(backend)
    const withdrawals = createWithdrawals({ db, now: () => Date.now() })
    const claims = createOwedClaims({ db })
    await withdrawals.create(burn("w1"))
    await claims.owe({
      paylinkId: LINK,
      paylink_ph: "ph",
      flavor: "direct",
      amount_bucket: "<50",
      at: Date.now(),
    })
    const saved = (prefix: string) =>
      [...backend.entries.keys()].filter((k) => k.startsWith(prefix))

    const runtime = sessions(startRuntime)
    runtime.tasks.push(
      withdrawReports({ withdrawals, funnel: createWithdrawFunnel({ db }), claims }),
    )
    runtime.start()
    await expect.poll(() => saved("acct/withdrawFunnel/")).toEqual(["acct/withdrawFunnel/w1"])
    expect(saved("acct/owedClaims/")).toHaveLength(1)

    await withdrawals.create(burn("w2", { source: "paylink", paylinkId: LINK, phase: "l2_mined" }))
    await expect.poll(() => saved("acct/owedClaims/")).toEqual([])
    runtime.end()
  })
})
