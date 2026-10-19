import { describe, expect, it, vi } from "vitest"
import type { MigrationFundingBatch } from "@obsidion/core/types"
import { UpgradeActivity } from "../../src/core/migration/upgradeActivity"

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
  it("lists a run's first batch from its record and each later batch by its state", async () => {
    const s = storage()
    s.items.set(
      RUN,
      JSON.stringify({
        phase: "recovering",
        plan: JSON.stringify({ sourceBatch: "proof" }),
        bootstrapTx: "0xboot",
      }),
    )
    s.items.set(`${RUN}/source/proof`, JSON.stringify(batch({ recipient: "0xmeta" })))
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

    expect(activity.items().map((i) => [i.id, i.first, i.state, i.tx, i.startTime])).toEqual([
      ["proof", true, "received", "0xboot", 10],
      ["remaining-0", false, "sent", "0xa", 20],
      ["remaining-2", false, "refunded", "0xb", 10],
      ["remaining-3", false, "planned", undefined, 10],
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

  it("keeps a received first batch received when a later step stops the run", async () => {
    const s = storage()
    s.items.set(
      RUN,
      JSON.stringify({
        phase: "needsAttention",
        plan: JSON.stringify({ sourceBatch: "p" }),
        bootstrapTx: "0xboot",
        subscriptionTx: "0xsub",
      }),
    )
    s.items.set(`${RUN}/source/p`, JSON.stringify(batch()))
    const activity = UpgradeActivity.get(s)

    await activity.addRun(RUN)

    expect(activity.items()[0]).toMatchObject({ first: true, state: "received" })
  })

  // A live source withdraws rather than refunds: its batches stay off this list.
  it("lists no batch of a live source", async () => {
    const s = storage()
    s.items.set(
      RUN,
      JSON.stringify({ phase: "arriving", plan: JSON.stringify({ sourceBatch: "0xhash" }) }),
    )
    const live = { binding: "b", recipient: "0xsipa", amount: "100", exitFee: "1", fromBlock: "1" }
    s.items.set(`${RUN}/source/0xhash`, JSON.stringify({ ...live, burnTx: "0xburn" }))
    s.items.set(`${RUN}/source/remaining`, JSON.stringify(live))
    const activity = UpgradeActivity.get(s)

    await activity.addRun(RUN)

    expect(activity.items()).toEqual([])
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

  it("reads an unpublished first batch as planned", async () => {
    const s = storage()
    s.items.set(
      RUN,
      JSON.stringify({ phase: "broadcasting", plan: JSON.stringify({ sourceBatch: "p" }) }),
    )
    s.items.set(`${RUN}/source/p`, JSON.stringify(batch()))
    const activity = UpgradeActivity.get(s)

    await activity.addRun(RUN)

    expect(activity.items()[0]).toMatchObject({ first: true, state: "planned" })
  })

  it("saves a batch even when activity cannot read the runs", async () => {
    const s = storage()
    s.items.set("metadata-migration/runs", JSON.stringify([RUN]))
    s.items.set(RUN, "{corrupt")
    const writes = UpgradeActivity.get(s).reporting(RUN, s)

    await writes.setItem(`${RUN}/source/remaining-0`, JSON.stringify(batch({ broadcastTx: "0xa" })))

    expect(s.items.has(`${RUN}/source/remaining-0`)).toBe(true)
  })
})
