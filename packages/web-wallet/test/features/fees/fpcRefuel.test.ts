// @vitest-environment node
/** The refuel task's checks run as background proofs, and a burst of owed checks shares one. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPace } from "@obsidion/core/cadence"
import {
  createProver,
  fixed,
  memoryBackend,
  memoryStore,
  openDatabase,
  startRuntime,
  type Runtime,
} from "@obsidion/front-core"
import type { FpcRefuelTarget } from "@obsidion/sdk"
import { fpcRefuels, REFUEL_COOLDOWN_MS } from "../../../src/features/fees/fpcRefuel"

const settle = () => vi.advanceTimersByTimeAsync(0)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const fpc = (address: string) => ({ address, artifact: {} } as unknown as FpcRefuelTarget)

let runtime: Runtime | undefined
beforeEach(() => void vi.useFakeTimers())
afterEach(() => {
  runtime?.stop()
  vi.useRealTimers()
})

/**
 * A started session's refuel task, owed nothing yet, over a fake check that ends when `checked`
 * resolves; `failing` fails once.
 */
async function refuels(failing = new Set<string>()) {
  const prover = createProver({ now: () => Date.now() })
  const owed = memoryStore<ReadonlyMap<string, FpcRefuelTarget>>(new Map())
  const checked = deferred()
  const log: string[] = []
  const refuel = {
    async refuel(target: FpcRefuelTarget) {
      const address = target.address.toString()
      log.push(address)
      await checked.promise
      if (failing.delete(address)) throw new Error("rpc down")
    },
  }
  const task = fpcRefuels({ owed, refuel: fixed("fpcRefuel", refuel), prover })
  const started = startRuntime([task], {
    db: openDatabase(memoryBackend()),
    milestones: { after: async () => true, reached: () => false },
    visible: memoryStore(true).readonly,
    pace: createPace(),
    now: () => Date.now(),
    sinceLoad: () => performance.now(),
  })
  runtime = started
  /** What a sponsored flow's `oweFpcRefuel` does. */
  const owe = (target = fpc("0xa")) =>
    owed.set(new Map(owed.get()).set(target.address.toString(), target))
  await settle()
  return { prover, log, owe, checked, started }
}

describe("the FPC refuel task", () => {
  it("starts no check while a user flow runs", async () => {
    const { prover, log, owe } = await refuels()
    const flow = deferred()
    const running = prover.runUserFlow(() => flow.promise)
    owe()
    await settle()
    expect(log).toEqual([])
    flow.resolve()
    await running
    await settle()
    expect(log).toEqual(["0xa"])
  })

  it("makes a user flow started during a check wait it out", async () => {
    const { prover, log, owe, checked } = await refuels()
    owe()
    await settle()
    expect(log).toEqual(["0xa"])
    const running = prover.runUserFlow(async () => void log.push("flow"))
    await settle()
    expect(log).toEqual(["0xa"])
    checked.resolve()
    await running
    expect(log).toEqual(["0xa", "flow"])
  })

  it("runs a user flow started during the first of two checks before the second", async () => {
    const { prover, log, owe, checked } = await refuels()
    owe(fpc("0xa"))
    owe(fpc("0xb"))
    await settle()
    expect(log).toEqual(["0xa"])
    const running = prover.runUserFlow(async () => {
      log.push("flow")
      owe(fpc("0xa"))
    })
    checked.resolve()
    await running
    await settle()
    expect(log).toEqual(["0xa", "flow", "0xb"])
    // The flow owes 0xa again: its next check waits for the cooldown.
    await vi.advanceTimersByTimeAsync(REFUEL_COOLDOWN_MS)
    expect(log).toEqual(["0xa", "flow", "0xb", "0xa"])
  })

  it("gives two sponsored flows that end in a burst one check", async () => {
    const { prover, log, owe, checked } = await refuels()
    checked.resolve()
    const second = deferred()
    const first = prover.runUserFlow(async () => owe())
    const other = prover.runUserFlow(async () => {
      await second.promise
      owe()
    })
    await first
    await settle()
    second.resolve()
    await other
    await vi.advanceTimersByTimeAsync(2 * REFUEL_COOLDOWN_MS)
    expect(log).toEqual(["0xa"])
  })

  it("runs a check owed after the last one only once the cooldown has passed", async () => {
    const { log, owe, checked } = await refuels()
    checked.resolve()
    owe()
    await settle()
    owe()
    await vi.advanceTimersByTimeAsync(REFUEL_COOLDOWN_MS - 1)
    expect(log).toEqual(["0xa"])
    await vi.advanceTimersByTimeAsync(1)
    expect(log).toEqual(["0xa", "0xa"])
  })

  it("keeps a failed check's FPC, and the ones after it, owed for the check the next owe runs", async () => {
    const { log, owe, checked } = await refuels(new Set(["0xa"]))
    checked.resolve()
    owe(fpc("0xa"))
    owe(fpc("0xb"))
    await settle()
    expect(log).toEqual(["0xa"])
    await vi.advanceTimersByTimeAsync(REFUEL_COOLDOWN_MS)
    expect(log).toEqual(["0xa"])
    owe(fpc("0xc"))
    await settle()
    expect(log).toEqual(["0xa", "0xa", "0xb", "0xc"])
  })

  it("proves nothing for a session stopped while its check waited for a user flow", async () => {
    const { prover, log, owe, started } = await refuels()
    const flow = deferred()
    const running = prover.runUserFlow(() => flow.promise)
    owe()
    await settle()
    started.stop()
    flow.resolve()
    await running
    await settle()
    expect(log).toEqual([])
  })
})
