import { L1_SWEEP_RECHECK_DEPTH } from "@obsidion/core/constants"
import type { SpendShape } from "@obsidion/sdk"
import { describe, expect, it, vi } from "vitest"
import {
  dismissRotation,
  recoverable,
  resumeRotation,
  retryMove,
  RotationFlowError,
  watchRotation,
  type SweepSeen,
} from "../../../src/core/rotation/backupRotationFlow"
import type { BackupRotationRecord } from "../../../src/engine/backupRotations"
import { funding, OWNER, signedRecord, word } from "../../__test-helpers__/backupRotation"
import { finish, harness } from "./rotationFlowHarness"

const seen = (blockNumber = 90, hash = 0x90): SweepSeen => ({
  index: "3",
  blockNumber,
  blockHash: word(hash),
  credited: 1400n,
})
/** The sweep as `swept` saved it, ten blocks behind the harness's settled block. */
const SAVED: NonNullable<BackupRotationRecord["sweep"]> = {
  index: "3",
  blockNumber: 90,
  blockHash: word(0x90),
  credited: "1400",
}
/** The first settled block at which the saved sweep is no longer re-read. */
const BOUND = SAVED.blockNumber! + L1_SWEEP_RECHECK_DEPTH
const EMPTY: SpendShape = { notes: [], depositTotal: 0n, balance: 0n }
const REROOT = { switched: true, rebound: true }

const rerooted = (over: Partial<BackupRotationRecord> = {}) =>
  signedRecord("rerooted", { sweep: SAVED, reroot: REROOT, ...over })
const done = (over: Partial<BackupRotationRecord> = {}) =>
  finish(
    signedRecord("done", {
      sweep: SAVED,
      reroot: REROOT,
      fundings: [funding({ outcome: "swept" })],
      ...over,
    }),
  )

describe("the sweep re-check", () => {
  it("keeps a sweep read unchanged and has the driver poll through the move's own wait", async () => {
    const { deps, store, world } = harness()
    world.sweep = seen()
    await store.put(rerooted())
    const result = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(result).toMatchObject({ wait: "approval", watch: true, record: { phase: "rerooted" } })
    expect(result.record.sweep).toEqual(SAVED)
  })

  it("reaches done with the watch open, and closes it once the sweep is deep", async () => {
    const { deps, store, world } = harness({ shape: EMPTY })
    world.sweep = seen()
    await store.put(rerooted())
    const finished = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(finished).toMatchObject({ watch: true, record: { phase: "done" } })
    expect(finished.record.rotation?.sharedSecretSalt).toBe(word(9))
    world.l1Settled = BOUND
    const closed = await resumeRotation(deps, finished.record)
    expect(closed.watch).toBeUndefined()
    expect(closed.record.sweep).toEqual({ ...SAVED, recheck: "deep" })
    expect(closed.record.rotation?.sharedSecretSalt).toBeUndefined()
    expect(deps.l1.sweep).toHaveBeenCalledTimes(2)
    expect((await resumeRotation(deps, closed.record)).watch).toBeUndefined()
    expect(deps.l1.sweep).toHaveBeenCalledTimes(2)
  })

  it("patches a sweep settled in another block, and reads one replaced at the tip as gone", async () => {
    const { deps, store, world } = harness()
    world.sweep = seen(92, 0x92)
    await store.put(done())
    const moved = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(moved.sweep).toEqual({ ...SAVED, blockNumber: 92, blockHash: word(0x92) })
    expect(moved).toMatchObject({ phase: "done", reroot: REROOT })
    // The funds sit at the address until the replacement settles: not held, nothing parked.
    world.sweep = seen(101, 0xa1)
    world.balance = 1400n
    const tip = await resumeRotation(deps, moved)
    expect(tip).toMatchObject({
      watch: true,
      record: { phase: "done", sweep: { ...moved.sweep, recheck: "gone" } },
    })
    expect(tip.record.unswept).toBeUndefined()
    world.l1Settled = 101
    world.balance = 0n
    const settled = (await resumeRotation(deps, tip.record)).record
    expect(settled.sweep).toEqual({ ...SAVED, blockNumber: 101, blockHash: word(0xa1) })
  })

  it("keeps the watch open through a declined move and its retry", async () => {
    const { deps, store, world } = harness()
    world.sweep = seen()
    const send = deps.move.send as ReturnType<typeof vi.fn>
    send.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    await store.put(rerooted())
    const declined = await resumeRotation(deps, (await store.get(OWNER))!, { prompt: true })
    expect(declined).toMatchObject({ wait: "declined", watch: true })
    send.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    const again = await retryMove(deps, declined.record)
    expect(again).toMatchObject({ wait: "declined", watch: true })
    const retried = await retryMove(deps, again.record)
    expect(retried).toMatchObject({ wait: "chunk", watch: true })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it("marks a dropped sweep gone, keeps the re-root, and clears the mark once a re-sweep settles", async () => {
    const { deps, store, world } = harness()
    world.sweep = undefined
    await store.put(done())
    const gone = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(gone).toMatchObject({
      phase: "done",
      reroot: REROOT,
      sweep: { ...SAVED, recheck: "gone" },
    })
    expect(gone.unswept).toBeUndefined()
    // The re-sweep sits at the tip, the funds at the address until it settles.
    world.sweep = seen(101, 0xa1)
    world.balance = 1400n
    const pending = await resumeRotation(deps, gone)
    expect(pending).toMatchObject({
      watch: true,
      record: { phase: "done", sweep: { recheck: "gone" } },
    })
    expect(pending.record.attention).toBeUndefined()
    expect(pending.record.unswept).toBeUndefined()
    world.sweep = seen(95, 0x95)
    world.balance = 0n
    const back = (await resumeRotation(deps, pending.record)).record
    expect(back.sweep).toEqual({ ...SAVED, blockNumber: 95, blockHash: word(0x95) })
  })

  it("gives a dropped sweep up as lost at the bound, and parks the funds left at the address", async () => {
    const { deps, store, world } = harness({ balance: 1400n })
    world.sweep = undefined
    world.l1Settled = BOUND
    await store.put(done({ sweep: { ...SAVED, recheck: "gone" } }))
    const lost = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(lost.watch).toBeUndefined()
    expect(lost.record).toMatchObject({
      phase: "attention",
      attention: "stranded",
      suspended: "done",
      unswept: true,
      sweep: { ...SAVED, recheck: "lost" },
    })
    expect(lost.record.rotation?.sharedSecretSalt).toBe(word(9))
    expect(recoverable(lost.record)).toBe(true)
  })

  it("moves the balance without waiting on the re-check, and past a read that fails", async () => {
    const { deps, store, world } = harness()
    world.sweep = undefined
    await store.put(rerooted())
    const sent = await resumeRotation(deps, (await store.get(OWNER))!, { prompt: true })
    expect(sent).toMatchObject({ wait: "chunk", watch: true })
    expect(sent.record.sweep?.recheck).toBe("gone")
    expect(deps.move.send).toHaveBeenCalledTimes(1)

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    for (const read of ["sweep", "isSettled", "settledBlock"] as const) {
      const failing = harness()
      failing.world.sweep = seen()
      ;(failing.deps.l1[read] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rpc"))
      await failing.store.put(rerooted())
      const record = (await failing.store.get(OWNER))!
      const result = await resumeRotation(failing.deps, record, { prompt: true })
      expect(result).toMatchObject({ wait: "chunk", watch: true })
      expect(result.record.sweep).toEqual(SAVED)
      expect(failing.deps.move.send).toHaveBeenCalledTimes(1)
    }
    warn.mockRestore()
  })

  it("removes a dismissed record only while it still reads as the done the step left", async () => {
    const { deps, store, world } = harness()
    world.sweep = seen()
    world.l1Settled = BOUND
    await store.put(done({ dismissed: true }))
    // Another run parks the record over funds at the address between the step's read and the removal.
    const removeIf = deps.store.removeIf
    deps.store.removeIf = async (owner, when) => {
      await deps.store.update(owner, (c) =>
        c
          ? { ...c, phase: "attention", attention: "stranded", suspended: "done", unswept: true }
          : null,
      )
      return removeIf(owner, when)
    }
    await resumeRotation(deps, (await store.get(OWNER))!)
    expect(await store.get(OWNER)).toMatchObject({
      phase: "attention",
      attention: "stranded",
      dismissed: true,
    })
  })

  it("keeps a dismissed record that another run marked over funds before the removal", async () => {
    const { deps, store, world } = harness()
    world.sweep = seen()
    world.l1Settled = BOUND
    await store.put(done({ dismissed: true }))
    // Another run finished over funds at the address and has not parked the record yet.
    const removeIf = deps.store.removeIf
    deps.store.removeIf = async (owner, when) => {
      await deps.store.update(owner, (c) => (c ? { ...c, unswept: true } : null))
      return removeIf(owner, when)
    }
    await resumeRotation(deps, (await store.get(OWNER))!)
    expect(await store.get(OWNER)).toMatchObject({ phase: "done", dismissed: true, unswept: true })
  })

  it("finishes over a gone sweep with funds at the address, parking nothing while the watch is open", async () => {
    const { deps, store, world } = harness({ shape: EMPTY, balance: 1400n })
    world.sweep = undefined
    await store.put(rerooted({ fundings: [funding({ outcome: "swept" })] }))
    const finished = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(finished).toMatchObject({ phase: "done", sweep: { recheck: "gone" } })
    expect(finished.attention).toBeUndefined()
    expect(finished.unswept).toBeUndefined()
    expect(finished.rotation?.sharedSecretSalt).toBe(word(9))
    const again = (await resumeRotation(deps, finished)).record
    expect(again.phase).toBe("done")
    expect(again.attention).toBeUndefined()
    world.sweep = seen(95, 0x95)
    world.balance = 0n
    const swept = (await resumeRotation(deps, again)).record
    expect(swept.sweep?.recheck).toBeUndefined()
    expect(swept.rotation?.sharedSecretSalt).toBe(word(9))
    world.l1Settled = 95 + L1_SWEEP_RECHECK_DEPTH
    const closed = (await resumeRotation(deps, swept)).record
    expect(closed.sweep?.recheck).toBe("deep")
    expect(closed.rotation?.sharedSecretSalt).toBeUndefined()
  })

  it("returns a parked finished record to done while its sweep is gone, and parks it again once lost", async () => {
    const { deps, store, world } = harness({ balance: 1400n })
    world.sweep = undefined
    await store.put(
      done({ phase: "attention", attention: "stranded", suspended: "done", unswept: true }),
    )
    const back = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(back).toMatchObject({ phase: "done", sweep: { recheck: "gone" } })
    expect(back.attention).toBeUndefined()
    expect(back.unswept).toBeUndefined()
    expect(back.rotation?.sharedSecretSalt).toBe(word(9))
    const parkedGone = { ...back, phase: "attention" as const, attention: "stranded" as const }
    expect(recoverable({ ...parkedGone, suspended: "done" })).toBe(false)
    world.l1Settled = BOUND
    const parked = (await resumeRotation(deps, back)).record
    expect(parked).toMatchObject({
      phase: "attention",
      attention: "stranded",
      suspended: "done",
      sweep: { recheck: "lost" },
    })
    expect(recoverable(parked)).toBe(true)
  })

  it("dismisses a done record: at once unless watched, else once the watch closes", async () => {
    const { deps, store, world } = harness()
    world.sweep = seen()
    await store.put(done())
    await dismissRotation(deps, (await store.get(OWNER))!)
    const kept = await store.get(OWNER)
    expect(kept).toMatchObject({ phase: "done", dismissed: true })
    const open = await resumeRotation(deps, kept!)
    expect(open.watch).toBe(true)
    expect(await store.get(OWNER)).toMatchObject({ dismissed: true })
    world.l1Settled = BOUND
    const closed = await resumeRotation(deps, open.record)
    expect(closed.record.sweep?.recheck).toBe("deep")
    expect(await store.get(OWNER)).toBeNull()

    await store.put(done({ sweep: { ...SAVED, recheck: "deep" } }))
    await dismissRotation(deps, (await store.get(OWNER))!)
    expect(await store.get(OWNER)).toBeNull()
  })

  it("keeps a dismissed record parked once its sweep is lost with funds at the address", async () => {
    const { deps, store, world } = harness({ balance: 1400n })
    world.sweep = undefined
    world.l1Settled = BOUND
    await store.put(done({ dismissed: true, sweep: { ...SAVED, recheck: "gone" } }))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({
      phase: "attention",
      attention: "stranded",
      dismissed: true,
      sweep: { recheck: "lost" },
    })
    expect(await store.get(OWNER)).toMatchObject({ phase: "attention", dismissed: true })
  })

  it("declines a write over a sweep the store re-checked since", async () => {
    const { deps, store } = harness()
    const shown = done()
    await store.put({ ...shown, sweep: { ...SAVED, recheck: "gone" } })
    await expect(dismissRotation(deps, shown)).rejects.toThrow(RotationFlowError)
    expect((await store.get(OWNER))?.dismissed).toBeUndefined()
  })

  it("re-reads nothing for a sweep saved without its block, or on a record before the sweep", async () => {
    const { deps, store, world } = harness()
    world.sweep = undefined
    const { blockNumber: _block, ...bare } = SAVED
    await store.put(done({ sweep: bare }))
    const unwatched = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(unwatched.watch).toBeUndefined()
    expect(unwatched.record.sweep).toEqual(bare)
    expect(deps.l1.sweep).not.toHaveBeenCalled()

    await store.put(
      signedRecord("installed", { sweep: SAVED, installed: { blockHash: word(0x41) } }),
    )
    const installed = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(installed).toMatchObject({ record: { phase: "rerooted", sweep: SAVED } })
    expect(installed.watch).toBeUndefined()
    expect(deps.l1.sweep).not.toHaveBeenCalled()

    await store.put(
      signedRecord("attention", { attention: "stranded", suspended: "funded", sweep: SAVED }),
    )
    const funded = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(funded.record.sweep?.recheck).toBeUndefined()
    expect(funded.watch).toBeUndefined()
  })

  it("asks for the short poll while a sweep it saw settles, and the usual one with none seen", async () => {
    const { deps, store, world } = harness()
    world.sweep = seen(101, 0xa1)
    await store.put(signedRecord("funded"))
    const funded = (await store.get(OWNER))!
    expect(await watchRotation(deps, funded)).toEqual({ record: funded, wait: "sweep", soon: true })
    expect(await resumeRotation(deps, funded)).toMatchObject({ wait: "sweep", soon: true })
    await store.put(signedRecord("published"))
    const published = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(published).toMatchObject({ wait: "sweep", soon: true })
    world.sweep = undefined
    expect(await watchRotation(deps, funded)).toEqual({ record: funded, wait: "sweep" })
  })
})
