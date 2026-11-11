/** How the activity feed lists a backup passkey add: its funding, its deposit and its price. */
import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import type { BackupRotationRecord } from "../../src/engine/backupRotations"
import type { SipaDeposit } from "../../src/engine/sipaDeposits"
import type { FeedItem } from "../../src/engine/activityFeed"
import { E18, HOUR, NOW, addr, burn, deposit, feedOf } from "./feedFixtures"

describe("selectFeed: backup passkey adds", () => {
  // Its sweep can wait far past the stuck clock, and a stuck row would offer nothing.
  it("keeps a backup passkey's stalled deposit behind its funding", () => {
    const stalled = deposit({
      sipaAddress: addr("06"),
      intent: "add-passkey",
      phase: "sweeping",
      amount: "1.1",
      netAmount: undefined,
      startTime: NOW - HOUR,
    })
    const funding = burn({ recipient: addr("06"), intent: "backup" })
    const shown = (d: SipaDeposit) =>
      feedOf({ deposits: [d], withdrawals: [funding] }).items.filter((i) => i.kind === "deposit")
    expect(shown(stalled)).toEqual([])
    expect(shown({ ...stalled, intent: undefined })).toHaveLength(1)
  })

  it("files a SIPA the account pays itself as a backup passkey's arrival, added once swept", () => {
    const arrival = deposit({ intent: "add-passkey" })
    const [item] = feedOf({ deposits: [arrival] }).items
    expect(item).toMatchObject({ kind: "deposit", intent: "backup" })
    expect(item).not.toHaveProperty("stopped")
    expect(item).not.toHaveProperty("added")
    const [swept] = feedOf({ deposits: [{ ...arrival, claimedInboxIndexes: ["1"] }] }).items
    expect(swept).toMatchObject({ kind: "deposit", intent: "backup", added: true })
  })

  // The funding row carries a stopped add's recovery; the deposit alone must not claim the add.
  it("keeps a stopped backup add's deposit behind its funding, and marks it stopped alone", () => {
    const held = deposit({ sipaAddress: addr("07"), intent: "add-passkey", phase: "recoverable" })
    const funding = burn({ recipient: addr("07"), intent: "backup" })
    const shown = (d: SipaDeposit, withdrawals = [funding]) =>
      feedOf({ deposits: [d], withdrawals }).items.filter((i) => i.kind === "deposit")
    expect(shown(held)).toEqual([])
    expect(shown({ ...held, phase: "failed" })).toEqual([])
    expect(shown(held, [])).toEqual([expect.objectContaining({ intent: "backup", stopped: true })])
    // Paid again after its sweep: the change ran, so the reopened deposit surfaces as the add.
    const reopened = { ...held, sweepTxHash: `0x${"01".repeat(32)}` as Hex }
    expect(shown(reopened)).toEqual([expect.not.objectContaining({ stopped: true })])
  })

  it("marks a backup funding added once its add ran, not while its sweep waits", () => {
    const funding = burn({ localId: "wdraw_backup_a1", recipient: addr("08"), intent: "backup" })
    const attempt = (phase: BackupRotationRecord["phase"]) =>
      ({ attemptId: "a1", phase, fundings: [{ localId: funding.localId }] } as BackupRotationRecord)
    const item = (rotations: readonly BackupRotationRecord[]) =>
      feedOf({ withdrawals: [funding], rotations }).items.find((i) => i.kind === "withdrawal")
    expect(item([attempt("funded")])).not.toHaveProperty("added")
    expect(item([attempt("done")])).toMatchObject({ kind: "withdrawal", added: true })
  })

  it("reads a stopped backup attempt's paid funding from its recovery, pending while sent", () => {
    const funding = burn({ localId: "wdraw_backup_a1", intent: "backup" })
    const rotation = {
      attemptId: "a1",
      phase: "attention",
      attention: "stranded",
      suspended: "funded",
      fundings: [{ localId: funding.localId }],
      recovery: { txHash: `0x${"06".repeat(32)}` },
    } as BackupRotationRecord
    const [item] = feedOf({ withdrawals: [funding], rotations: [rotation] }).items
    expect(item).toMatchObject({ kind: "withdrawal", pending: true, recovery: { state: "sent" } })
    const [plain] = feedOf({ withdrawals: [funding] }).items
    expect(plain).toMatchObject({ kind: "withdrawal", pending: false })
    expect((plain as Extract<FeedItem, { kind: "withdrawal" }>).recovery).toBeUndefined()
    const [unread] = feedOf({ withdrawals: [funding], rotations: "unread" }).items
    expect(unread).toMatchObject({
      kind: "withdrawal",
      pending: true,
      recovery: { state: "unread" },
    })
  })

  const backupLeftover = () => {
    const credit = { netAmount: ((6n * E18) / 10n).toString(), fee: ((5n * E18) / 10n).toString() }
    const sweep = { inboxIndex: "1", sweepTxHash: `0x${"01".repeat(32)}`, ...credit }
    return deposit({ sipaAddress: addr("05"), intent: "add-passkey", ...credit, sweeps: [sweep] })
  }
  // 1.30 sent, 1.10 released to the address.
  const backupFees = {
    relayerTip: (E18 / 20n).toString(),
    withdrawalFee: ((15n * E18) / 100n).toString(),
  }

  it("prices a backup passkey add's one row at its cost, once the leftover is credited back", () => {
    const leftover = backupLeftover()
    const funding = burn({
      recipient: addr("05"),
      intent: "backup",
      amount: "1.3",
      tokenDecimals: 18,
      ...backupFees,
    })
    const { items } = feedOf({ deposits: [leftover], withdrawals: [funding] })
    expect(items).toEqual([
      expect.objectContaining({
        kind: "withdrawal",
        cost: expect.objectContaining({ costDisplay: "0.7" }),
      }),
    ])
  })

  it("lists a backup passkey funding rebuilt from chain as the add, priced at its cost", () => {
    // A fresh device rebuilds the burn from the previous account's events, with no intent.
    const leftover = backupLeftover()
    const funding = burn({
      recipient: addr("05"),
      amount: "1.3",
      tokenDecimals: 18,
      rebuilt: true,
      ...backupFees,
    })
    const plain = burn({ localId: "w2", recipient: addr("e2"), tokenDecimals: 18, rebuilt: true })
    const { items } = feedOf({ deposits: [leftover], withdrawals: [funding, plain] })
    expect(items).toEqual([
      expect.objectContaining({
        id: "w1",
        intent: "backup",
        cost: expect.objectContaining({ costDisplay: "0.7" }),
      }),
      expect.objectContaining({ id: "w2", intent: undefined, cost: undefined }),
    ])
  })
})
