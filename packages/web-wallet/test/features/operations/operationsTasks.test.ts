/**
 * The session's operation tasks. The settle pass keeps a 10 s pace while visible; the sweep runs
 * once per session and ends only what started by the time the tab became the active tab: anything
 * later is this tab's own. Both wait for the wallet; the proving marks run from the start.
 */
import { afterEach, expect, it, vi } from "vitest"
import { ProvingStage } from "@obsidion/core/types"
import {
  createWithdrawals,
  memoryBackend,
  memoryStore,
  openDatabase,
  startRuntime,
  type ProvingProgress,
} from "@obsidion/front-core"
import {
  interruptedSweep,
  operationsSettle,
  provingMarks,
} from "../../../src/features/operations/operationsTasks"
import { later, periodicSteps, sessions, table } from "../../../../front-core/test/engine/taskTable"
import { testOperations } from "../../support/operations"

const db = openDatabase(memoryBackend())
const ends: (() => void)[] = []
afterEach(() => {
  for (const end of ends.splice(0)) end()
  vi.useRealTimers()
})

/** Sessions over one task and a wallet the test makes ready. */
function harness() {
  const wallet = later<{ node: never }>("wallet")
  const h = sessions(startRuntime)
  ends.push(h.end)
  return { ...h, wallet: wallet.service, ready: () => wallet.ready({ node: "node" as never }) }
}

it("settles sent operations once the wallet is ready, every 10 s while visible, at once on show", async () => {
  vi.useFakeTimers()
  const resolveSent = vi.fn(async () => {})
  const h = harness()
  h.tasks.push(operationsSettle({ wallet: h.wallet, operations: { resolveSent } }))
  await table(periodicSteps(h, h.ready, 10_000), () => resolveSent.mock.calls.length)
  expect(resolveSent).toHaveBeenLastCalledWith("node")
})

it("sweeps once the wallet is ready, up to when the tab became active, and once per session", async () => {
  const store = testOperations()
  const begin = async (operationId: string, startedAt: number) => {
    await store.begin({ operationId, flow: "send", summary: "$5" }, startedAt)
    await store.apply(operationId, { type: "proving", at: startedAt })
  }
  await begin("before", 4_000)
  await begin("after", 6_000)
  const states = () =>
    Object.fromEntries(store.view.get().records.map((r) => [r.operationId, r.state]))
  const h = harness()
  h.tasks.push(
    interruptedSweep({
      wallet: h.wallet,
      withdrawals: createWithdrawals({ db, now: () => Date.now() }),
      operations: store,
      activeSince: () => 5_000,
    }),
  )
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
  h.start()
  await settle()
  expect(states()).toEqual({ before: "local", after: "local" })

  h.ready()
  await vi.waitFor(() => expect(states()).toEqual({ before: "failed", after: "local" }))

  await begin("later", 4_500)
  h.hide()
  h.show()
  h.stop()
  await settle()
  expect(states().later).toBe("local")

  h.start()
  await vi.waitFor(() => expect(states().later).toBe("failed"))
  expect(states().after).toBe("local")
})

it("marks an operation proving from its prover stage while the page is hidden, but no stage it found", async () => {
  const store = testOperations()
  await store.begin({ operationId: "found", flow: "send", summary: "$5" })
  await store.begin({ operationId: "hidden", flow: "send", summary: "$5" })
  const stage = (at: number) => ({ stage: ProvingStage.Proving, at })
  const progress = memoryStore<ProvingProgress>({
    stages: { found: stage(1_000) },
    signing: { started: 0, ended: 0, failed: false },
    waitingForLastSend: false,
  })
  const h = sessions(startRuntime)
  ends.push(h.end)
  h.tasks.push(provingMarks(progress.readonly, store))
  h.hide()
  h.start()
  progress.update((p) => ({ ...p, stages: { ...p.stages, hidden: stage(2_000) } }))
  const startedAt = (id: string) =>
    store.view.get().records.find((r) => r.operationId === id)?.provingStartedAt
  await vi.waitFor(() => expect(startedAt("hidden")).toBe(2_000))
  expect(startedAt("found")).toBeUndefined()
})
