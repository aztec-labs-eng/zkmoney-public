import { describe, expect, it, vi } from "vitest"
import type { MigrationFundingBatch } from "@obsidion/core/types"
import { UpgradeActivity } from "../../src/core/migration/upgradeActivity"
import { directDepositKey } from "../../src/core/services/deposits/SIPADepositStore"

const RUN = "metadata-migration/0xnew/0xold/0xaccount"

function storage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => void items.set(key, value),
  }
}

const batch = (patch: Partial<MigrationFundingBatch> = {}): MigrationFundingBatch => ({
  binding: "b",
  recipient: "0xsipa",
  amount: "100",
  exitFee: "1",
  fromBlock: "1",
  createdAt: 10,
  sourceSelection: ["n"],
  ...patch,
})

describe("upgrade activity", () => {
  it("lists each batch of a run by its state", async () => {
    const s = storage()
    s.items.set(RUN, JSON.stringify({ phase: "recovering", plan: JSON.stringify({}) }))
    s.items.set(
      `${RUN}/source/remaining-0`,
      JSON.stringify(batch({ broadcastTx: "0xa", sentAt: 20 })),
    )
    s.items.set(`${RUN}/source/remaining-1`, JSON.stringify(batch({ abandoned: true })))
    s.items.set(
      `${RUN}/source/remaining-2`,
      JSON.stringify(batch({ refunded: true, broadcastTx: "0xb" })),
    )
    s.items.set(`${RUN}/source/remaining-3`, JSON.stringify(batch()))
    const activity = UpgradeActivity.get(s)

    await activity.addRun(RUN)

    expect(activity.items().map((i) => [i.id, i.state, i.tx, i.startTime])).toEqual([
      ["remaining-0", "sent", "0xa", 20],
      ["remaining-2", "refunded", "0xb", 10],
      ["remaining-3", "planned", undefined, 10],
    ])
  })

  it("marks each batch by its own approval", async () => {
    const s = storage()
    s.items.set(RUN, JSON.stringify({ phase: "needsApproval", plan: JSON.stringify({}) }))
    s.items.set(`${RUN}/source/remaining-0`, JSON.stringify(batch({ approved: true })))
    s.items.set(`${RUN}/source/remaining-1`, JSON.stringify(batch()))
    const activity = UpgradeActivity.get(s)

    await activity.addRun(RUN)

    expect(activity.items().map((i) => [i.id, i.approved])).toEqual([
      ["remaining-0", true],
      ["remaining-1", false],
    ])
  })

  it("registers a run once and tells listeners of every change", async () => {
    const s = storage()
    const activity = UpgradeActivity.get(s)
    const listener = vi.fn()
    activity.onChanged(listener)

    await activity.addRun(RUN)
    await activity.addRun(RUN)
    await activity.changed()

    expect(await activity.runs()).toEqual([RUN])
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it("names every batch's deposit address", async () => {
    const s = storage()
    s.items.set(RUN, JSON.stringify({ phase: "arriving", plan: JSON.stringify({}) }))
    s.items.set(`${RUN}/source/remaining-0`, JSON.stringify(batch({ recipient: "0xFirst" })))
    s.items.set(`${RUN}/source/remaining-1`, JSON.stringify(batch({ recipient: "0xLast" })))
    const activity = UpgradeActivity.get(s)

    await activity.addRun(RUN)

    expect([...activity.recipients()].sort()).toEqual(["0xfirst", "0xlast"])
  })

  it("lists a run before its record is written, and refuses the write when it cannot", async () => {
    const s = storage()
    const writes = UpgradeActivity.get(s).reporting(RUN, s)

    await writes.setItem(RUN, JSON.stringify({ phase: "preparing" }))
    expect(s.items.get("metadata-migration/runs")).toBe(JSON.stringify([RUN]))

    const failing = storage()
    const setItem = failing.setItem
    failing.setItem = async (key, value) => {
      if (key === "metadata-migration/runs") throw new Error("storage full")
      return setItem(key, value)
    }
    const refused = UpgradeActivity.get(failing).reporting(RUN, failing)
    await expect(refused.setItem(RUN, JSON.stringify({ phase: "preparing" }))).rejects.toThrow()
    expect(failing.items.has(RUN)).toBe(false)
  })

  // A session's storage refuses another account's namespace, so a run never lands in its index.
  it("registers a run through the storage of the session that writes it", async () => {
    const shared = storage()
    const session = storage()
    const activity = UpgradeActivity.get(shared)

    await activity.addRun(RUN, session)

    expect(session.items.get("metadata-migration/runs")).toBe(JSON.stringify([RUN]))
    expect(shared.items.has("metadata-migration/runs")).toBe(false)
  })

  it("keeps every run two writers register at once", async () => {
    const s = storage()
    const { getItem, setItem } = s
    const later = () => new Promise((r) => setTimeout(r, 0))
    s.getItem = async (key) => (await later(), getItem(key))
    s.setItem = async (key, value) => (await later(), setItem(key, value))
    const activity = UpgradeActivity.get(s)

    await Promise.all([activity.addRun(`${RUN}/a`), activity.addRun(`${RUN}/b`)])

    expect(await activity.runs()).toEqual([`${RUN}/a`, `${RUN}/b`])
  })

  it("shows the latest load when an earlier one finishes after it, as across an account switch", async () => {
    const s = storage()
    s.items.set("metadata-migration/runs", JSON.stringify([RUN]))
    s.items.set(RUN, JSON.stringify({ phase: "recovering" }))
    s.items.set(`${RUN}/source/remaining-0`, JSON.stringify(batch()))
    const read = s.getItem
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let first = true
    s.getItem = async (key) => {
      const value = await read(key)
      if (key === "metadata-migration/runs" && first) {
        first = false
        await held
      }
      return value
    }
    const activity = UpgradeActivity.get(s)

    const stale = activity.changed()
    s.items.set("metadata-migration/runs", "[]")
    await activity.changed()
    release()
    await stale

    expect(activity.items()).toEqual([])
  })

  it("saves a batch even when activity cannot read the runs", async () => {
    const s = storage()
    s.items.set("metadata-migration/runs", JSON.stringify([RUN]))
    s.items.set(RUN, "{corrupt")
    const writes = UpgradeActivity.get(s).reporting(RUN, s)

    await writes.setItem(`${RUN}/source/remaining-0`, JSON.stringify(batch({ broadcastTx: "0xa" })))

    expect(s.items.has(`${RUN}/source/remaining-0`)).toBe(true)
  })

  it("lists a direct batch under its deposit record's key, and hands the rail each sent one", async () => {
    const s = storage()
    const direct = (n: string) => ({
      executor: "0xe0" as `0x${string}`,
      subsidy: "0xf0" as `0x${string}`,
      day: 1,
      nonce: Number(n),
      recipientCommitment: `0x${n.repeat(64)}` as `0x${string}`,
    })
    s.items.set(RUN, JSON.stringify({ phase: "recovering", plan: JSON.stringify({}) }))
    s.items.set(
      `${RUN}/source/remaining-0`,
      JSON.stringify(
        batch({
          recipient: direct("1").recipientCommitment,
          direct: direct("1"),
          broadcastTx: "0xa",
        }),
      ),
    )
    s.items.set(
      `${RUN}/source/remaining-1`,
      JSON.stringify(batch({ recipient: direct("2").recipientCommitment, direct: direct("2") })),
    )
    s.items.set(`${RUN}/source/remaining-2`, JSON.stringify(batch({ broadcastTx: "0xb" })))
    const activity = UpgradeActivity.get(s)

    await activity.addRun(RUN)

    const key = directDepositKey(direct("1").recipientCommitment)
    expect(activity.items()[0]).toMatchObject({
      recipient: key,
      direct: direct("1"),
      fromBlock: "1",
    })
    expect(activity.recipients().has(key.toLowerCase())).toBe(true)
    expect((await activity.directBatches()).map((i) => i.id)).toEqual(["remaining-0"])
  })
})
