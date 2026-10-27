import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "eventemitter3"
import {
  BOOT_ORDER,
  BootPriority,
  type BootReader,
} from "../../../src/core/services/transactions/bootPriority"

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
    void boot.whenReady("paylinkRescan").then(() => (released = true))

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
    void boot.whenReady("deposits").then(() => (notes = true))
    void boot.whenReady("paylinkRescan").then(() => (balance = true))
    boot.notesSynced()
    await vi.advanceTimersByTimeAsync(0)
    expect(notes).toBe(true)
    expect(balance).toBe(false)
  })

  it("releases every reader at its stage in BOOT_ORDER, and reports it ready", async () => {
    const boot = new BootPriority({ catchUp: catchUpSource() })
    const readers = Object.keys(BOOT_ORDER) as BootReader[]
    const released = new Set<BootReader>()
    for (const reader of readers) void boot.whenReady(reader).then(() => released.add(reader))
    const atStage = (stage: string) => readers.filter((r) => BOOT_ORDER[r] === stage)

    boot.notesSynced()
    await vi.advanceTimersByTimeAsync(0)
    expect([...released].sort()).toEqual(atStage("notes").sort())
    expect(readers.filter((r) => boot.isReady(r)).sort()).toEqual(atStage("notes").sort())

    boot.depositsReplayed()
    await vi.advanceTimersByTimeAsync(0)
    // No boot sync: restore readers wait for the balance like the rest.
    const settled = [...atStage("notes"), ...atStage("restore"), ...atStage("settled")].sort()
    expect([...released].sort()).toEqual(settled)
    expect(readers.filter((r) => boot.isReady(r)).sort()).toEqual(settled)

    boot.historyReplayed()
    await vi.advanceTimersByTimeAsync(0)
    expect(released.size).toBe(readers.length)
    expect(readers.every((r) => boot.isReady(r))).toBe(true)
  })

  it("does not report a reader ready whose wait only gave up", async () => {
    const boot = new BootPriority({ waitMs: 1_000, catchUp: catchUpSource() })
    let released = false
    void boot.whenReady("savings").then(() => (released = true))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(released).toBe(true)
    expect(boot.isReady("savings")).toBe(false)
  })

  it("settles deposits on its own backstop after notes", async () => {
    const boot = new BootPriority({ depositsWaitMs: 1_000, catchUp: catchUpSource() })
    let balance = false
    void boot.whenReady("paylinkRescan").then(() => (balance = true))
    boot.notesSynced()
    await vi.advanceTimersByTimeAsync(999)
    expect(balance).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(balance).toBe(true)
  })

  it("settles history only after the balance, however early the scanner reached head", async () => {
    const boot = new BootPriority({ catchUp: catchUpSource() })
    let released = false
    void boot.whenReady("depositPool").then(() => (released = true))
    boot.historyReplayed()
    boot.notesSynced()
    await vi.advanceTimersByTimeAsync(0)
    expect(released).toBe(false)
    boot.depositsReplayed()
    await vi.advanceTimersByTimeAsync(0)
    expect(released).toBe(true)
  })

  it("settles history on its own backstop after the balance", async () => {
    const boot = new BootPriority({ historyWaitMs: 1_000, catchUp: catchUpSource() })
    let released = false
    void boot.whenReady("depositPool").then(() => (released = true))
    boot.notesSynced()
    boot.depositsReplayed()
    await vi.advanceTimersByTimeAsync(999)
    expect(released).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(released).toBe(true)
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
    boot.movesReplayed()
    await vi.advanceTimersByTimeAsync(0)
    expect(boot.isBalanceSyncing()).toBe(false)
    expect(catchUp.ownHolds()).toBe(0)
    catchUp.set(true)
    expect(boot.isBalanceSyncing()).toBe(false)
    expect(catchUp.ownHolds()).toBe(0)
  })

  it("on a catching-up device, runs restore readers at notes and settles once the moves are replayed too", async () => {
    const catchUp = catchUpSource()
    const boot = new BootPriority({ catchUp })
    catchUp.set(true)
    let restored = false
    let balance = false
    void boot.whenReady("savingsMoves").then(() => (restored = true))
    void boot.whenReady("paylinkRescan").then(() => (balance = true))

    boot.notesSynced()
    await vi.advanceTimersByTimeAsync(0)
    expect(restored).toBe(true)
    expect(boot.isReady("withdrawalRescan")).toBe(true)

    boot.depositsReplayed()
    await vi.advanceTimersByTimeAsync(0)
    expect(balance).toBe(false)
    expect(boot.isBalanceSyncing()).toBe(true)

    boot.movesReplayed()
    await vi.advanceTimersByTimeAsync(0)
    expect(balance).toBe(true)
    expect(boot.isBalanceSyncing()).toBe(false)
  })

  it("keeps a boot sync open past the deposits backstop until the replays end", async () => {
    const catchUp = catchUpSource()
    const boot = new BootPriority({ depositsWaitMs: 1_000, catchUp })
    catchUp.set(true)
    let balance = false
    void boot.whenReady("paylinkRescan").then(() => (balance = true))
    boot.notesSynced()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(balance).toBe(true)
    expect(boot.isBalanceSyncing()).toBe(true)
    expect(catchUp.ownHolds()).toBe(1)

    boot.depositsReplayed()
    boot.movesReplayed()
    await vi.advanceTimersByTimeAsync(0)
    expect(boot.isBalanceSyncing()).toBe(false)
    expect(catchUp.ownHolds()).toBe(0)
  })

  it("closes a boot sync whose replays never end on its own backstop after notes", async () => {
    const catchUp = catchUpSource()
    const boot = new BootPriority({ depositsWaitMs: 1_000, syncWaitMs: 3_000, catchUp })
    catchUp.set(true)
    boot.notesSynced()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(boot.isBalanceSyncing()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
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
    boot.movesReplayed()
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
    void boot.whenReady("paylinkRescan").then(() => (released = true))
    await vi.advanceTimersByTimeAsync(900)
    boot.notesSynced()
    await vi.advanceTimersByTimeAsync(999)
    expect(released).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(released).toBe(true)
  })
})
