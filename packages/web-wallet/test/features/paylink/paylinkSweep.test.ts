// @vitest-environment node
/**
 * The sent links' rescan and claim sweep as a session task: it waits for the boot milestones, runs
 * every minute while visible, and reports whether its latest rebuild read every link.
 */
import { afterEach, expect, it, vi } from "vitest"
import { startRuntime, type ReadonlyStore, type Task } from "@obsidion/front-core"
import { paylinkSweep, type SweepPass } from "../../../src/features/paylink/paylinkTasks"
import { later, periodicSteps, sessions, table } from "../../../../front-core/test/engine/taskTable"

const ends: (() => void)[] = []
afterEach(() => {
  for (const end of ends.splice(0)) end()
  vi.useRealTimers()
})

/** A pass whose rebuild answers `complete`, or throws when it is an Error. */
function fakePass(complete: () => boolean | Error | Promise<boolean>) {
  const calls = { rescans: 0, reconciles: 0 }
  const pass: SweepPass = {
    async rescan() {
      calls.rescans++
      const answer = await complete()
      if (answer instanceof Error) throw answer
      return answer
    },
    async reconcile() {
      calls.reconciles++
    },
  }
  return { pass, calls }
}

function harness(pass: SweepPass, milestones?: Parameters<typeof sessions>[1]) {
  const needs = {
    wallet: later<never>("wallet"),
    account: later<never>("account"),
    token: later<never>("token"),
    contractService: later<never>("contractService"),
  }
  let runtime: ReturnType<typeof startRuntime> | undefined
  const h = sessions((tasks, deps) => (runtime = startRuntime(tasks, deps)), milestones)
  ends.push(h.end)
  const sweep = paylinkSweep(
    {
      wallet: needs.wallet.service,
      account: needs.account.service,
      token: needs.token.service,
      contractService: needs.contractService.service,
    },
    () => pass,
    (task: Task) => runtime!.wake(task),
  )
  h.tasks.push(sweep.task)
  const ready = () => Object.values(needs).forEach((need) => need.ready({} as never))
  return { ...h, sweep, ready, lose: () => needs.wallet.lose() }
}

const seen = <T>(store: ReadonlyStore<T>) => {
  const values: T[] = []
  store.subscribe(() => values.push(store.get()))
  return values
}

it("sweeps once its needs are ready, every minute while visible, at once on show", async () => {
  vi.useFakeTimers()
  const { pass, calls } = fakePass(() => true)
  const h = harness(pass)
  await table(periodicSteps(h, h.ready, 60_000), () => calls.reconciles)
  expect(calls.rescans).toBe(calls.reconciles)
})

it("waits for the boot milestones before the first pass", async () => {
  vi.useFakeTimers()
  let reach: (reached: boolean) => void = () => {}
  const milestones = {
    after: () => new Promise<boolean>((resolve) => (reach = resolve)),
    reached: () => false,
  }
  const { pass, calls } = fakePass(() => true)
  const h = harness(pass, milestones as never)
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(calls.rescans).toBe(0)
  reach(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(calls.rescans).toBe(1)
  expect(h.sweep.rescanned.get()).toBe(true)
})

it("reads unknown before a pass, incomplete after a failed rebuild, and still sweeps", async () => {
  vi.useFakeTimers()
  const answers: Array<boolean | Error> = [new Error("node down"), false, true]
  const { pass, calls } = fakePass(() => answers.shift()!)
  const h = harness(pass)
  vi.spyOn(console, "warn").mockImplementation(() => {})
  expect(h.sweep.rescanned.get()).toBeUndefined()
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect([h.sweep.rescanned.get(), calls.reconciles]).toEqual([false, 1])
  await vi.advanceTimersByTimeAsync(60_000)
  expect([h.sweep.rescanned.get(), calls.reconciles]).toEqual([false, 2])
  await vi.advanceTimersByTimeAsync(60_000)
  expect([h.sweep.rescanned.get(), calls.reconciles]).toEqual([true, 3])
})

it("checks from a recheck until the pass it asked for ends, even one queued behind a run", async () => {
  vi.useFakeTimers()
  const finishes: Array<(complete: boolean) => void> = []
  const { pass, calls } = fakePass(() => new Promise<boolean>((resolve) => finishes.push(resolve)))
  const h = harness(pass)
  const checking = seen(h.sweep.checking)
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect([h.sweep.checking.get(), calls.rescans]).toEqual([false, 1])

  h.sweep.recheck()
  expect(h.sweep.checking.get()).toBe(true)
  finishes.shift()!(true)
  await vi.advanceTimersByTimeAsync(0)
  expect([h.sweep.checking.get(), calls.rescans]).toEqual([true, 2])
  finishes.shift()!(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(h.sweep.checking.get()).toBe(false)
  expect(checking).toEqual([true, false])
})

it("a pass aborted mid-rebuild ends at once, records nothing and sweeps nothing", async () => {
  vi.useFakeTimers()
  const { pass, calls } = fakePass(() => new Promise<boolean>(() => {}))
  const h = harness(pass)
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  h.sweep.recheck()
  h.lose()
  await vi.advanceTimersByTimeAsync(0)
  expect([h.sweep.rescanned.get(), calls.reconciles]).toEqual([undefined, 0])
  expect(h.sweep.checking.get()).toBe(false)
})

it("hands the run's signal to the sweep, so a hidden page's pass stops writing", async () => {
  vi.useFakeTimers()
  const heard: AbortSignal[] = []
  const pass: SweepPass = {
    rescan: async () => true,
    reconcile: (signal) => {
      heard.push(signal)
      return new Promise(() => {})
    },
  }
  const h = harness(pass)
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(heard.map((s) => s.aborted)).toEqual([false])
  h.hide()
  await vi.advanceTimersByTimeAsync(0)
  expect(heard.map((s) => s.aborted)).toEqual([true])
})
