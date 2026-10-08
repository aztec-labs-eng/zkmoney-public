/**
 * The sweep waits for this tab's boot, and ends only what started by the time the tab became the
 * active tab: anything later is this tab's own.
 */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ status: "booting" as "booting" | "ready" | "error" }))
vi.mock("../src/ui/PxeBoot", () => ({ usePxeBoot: () => ({ bootStatus: h.status }) }))
vi.mock("@obsidion/front-core", async (original) => ({
  ...(await original<object>()),
  useAztecContext: () => ({ obsidionWallet: undefined }),
}))

import { getOperationStore } from "../src/features/operations/operations"
import { OperationsMount } from "../src/features/operations/OperationsMount"

it("sweeps nothing until this tab's boot is ready, then up to when it became active", async () => {
  const store = getOperationStore()
  const resolveSent = vi.spyOn(store, "resolveSent").mockResolvedValue()
  for (const [operationId, startedAt] of [
    ["before", 4_000],
    ["after", 6_000],
  ] as const) {
    await store.begin({ operationId, flow: "send", summary: "$5", scope: null }, startedAt)
    await store.markProving(operationId, startedAt)
  }
  const states = () => Object.fromEntries(store.list().map((r) => [r.operationId, r.state]))
  const node = {} as never
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () => root.render(<OperationsMount node={node} activeSince={5_000} />))
  expect(states()).toEqual({ before: "local", after: "local" })
  expect(resolveSent).not.toHaveBeenCalled()

  h.status = "ready"
  await act(async () => root.render(<OperationsMount node={node} activeSince={5_000} />))
  await vi.waitFor(() => expect(states()).toEqual({ before: "failed", after: "local" }))
  expect(resolveSent).toHaveBeenCalled()
  await act(async () => root.unmount())
})
