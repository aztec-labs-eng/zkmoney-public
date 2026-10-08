import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "eventemitter3"
import { BootPriority } from "../../../src/core/services/transactions/bootPriority"

function catchUpSource() {
  const bus = new EventEmitter()
  let external = false
  let own = 0
  const emit = () => bus.emit("changed", external || own > 0)
  return {
    set: (value: boolean) => {
      external = value
      emit()
    },
    ownHolds: () => own,
    beginSyncCatchUp: () => {
      own++
      let ended = false
      return () => {
        if (ended) return
        ended = true
        own--
        emit()
      }
    },
    isSyncCatchingUp: () => external || own > 0,
    onSyncCatchUpChanged: (l: (v: boolean) => void) => void bus.on("changed", l),
    offSyncCatchUpChanged: (l: (v: boolean) => void) => void bus.off("changed", l),
  }
}

describe("BootPriority", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("settles the balance only once notes and deposits have both settled", async () => {
    const boot = new BootPriority({ catchUp: catchUpSource() })
    let released = false
    void boot.whenBalanceSettled().then(() => (released = true))

    boot.depositsReplayed()
    await vi.advanceTimersByTimeAsync(0)
    expect(released).toBe(false)

    boot.notesSynced()
    await vi.advanceTimersByTimeAsync(0)
    expect(released).toBe(true)
  })

  it("releases the notes wait without deposits", async () => {
    const boot = new BootPriority({ catchUp: catchUpSource() })
    let notes = false
    let balance = false
    void boot.whenNotesSynced().then(() => (notes = true))
    void boot.whenBalanceSettled().then(() => (balance = true))
    boot.notesSynced()
    await vi.advanceTimersByTimeAsync(0)
    expect(notes).toBe(true)
    expect(balance).toBe(false)
  })

  it("settles deposits on its own backstop after notes", async () => {
    const boot = new BootPriority({ depositsWaitMs: 1_000, catchUp: catchUpSource() })
    let balance = false
    void boot.whenBalanceSettled().then(() => (balance = true))
    boot.notesSynced()
    await vi.advanceTimersByTimeAsync(999)
    expect(balance).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(balance).toBe(true)
  })

  it("opens a boot sync on a catch-up before settle, holding its own catch-up until settle", async () => {
    const catchUp = catchUpSource()
    const boot = new BootPriority({ catchUp })
    expect(boot.isBalanceSyncing()).toBe(false)
    catchUp.set(true)
    catchUp.set(false)
    expect(boot.isBalanceSyncing()).toBe(true)
    expect(catchUp.isSyncCatchingUp()).toBe(true) // bridges the gap before the next catch-up
    boot.notesSynced()
    boot.depositsReplayed()
    await vi.advanceTimersByTimeAsync(0)
    expect(boot.isBalanceSyncing()).toBe(false)
    expect(catchUp.ownHolds()).toBe(0)
    catchUp.set(true)
    expect(boot.isBalanceSyncing()).toBe(false)
    expect(catchUp.ownHolds()).toBe(0)
  })

  it("closes a boot sync whose balance never settles after the bound, for good", async () => {
    const catchUp = catchUpSource()
    const boot = new BootPriority({ waitMs: 1_000, catchUp })
    catchUp.set(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(boot.isBalanceSyncing()).toBe(false)
    expect(catchUp.ownHolds()).toBe(0)
    catchUp.set(false)
    catchUp.set(true)
    expect(boot.isBalanceSyncing()).toBe(false)
  })

  it("reports replay progress only while the boot sync is open", async () => {
    const catchUp = catchUpSource()
    const boot = new BootPriority({ catchUp })
    boot.depositProgress(1, 4)
    expect(boot.balanceSyncProgress()).toBeNull() // no sync open yet
    catchUp.set(true)
    expect(boot.balanceSyncProgress()).toBeNull() // total not known yet
    boot.depositProgress(1, 4)
    expect(boot.balanceSyncProgress()).toBe(0.25)
    boot.notesSynced()
    boot.depositsReplayed()
    await vi.advanceTimersByTimeAsync(0)
    expect(boot.balanceSyncProgress()).toBeNull()
    boot.depositProgress(3, 4)
    expect(boot.balanceSyncProgress()).toBeNull()
  })

  it("never holds a warm start whose catch-up begins after settle", async () => {
    const catchUp = catchUpSource()
    const boot = new BootPriority({ catchUp })
    boot.notesSynced()
    boot.depositsReplayed()
    await vi.advanceTimersByTimeAsync(0)
    catchUp.set(true)
    expect(boot.isBalanceSyncing()).toBe(false)
  })

  it("bounds each stage's wait separately, without settling the balance", async () => {
    const boot = new BootPriority({ waitMs: 1_000, catchUp: catchUpSource() })
    let released = false
    void boot.whenBalanceSettled().then(() => (released = true))
    await vi.advanceTimersByTimeAsync(900)
    boot.notesSynced()
    await vi.advanceTimersByTimeAsync(999)
    expect(released).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(released).toBe(true)
  })
})
