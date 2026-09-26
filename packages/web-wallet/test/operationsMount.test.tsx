/**
 * Only the tab that holds the wallet sweeps: a second tab's boot must not end the operations the
 * first one is still running.
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

it("sweeps nothing until this tab's boot is ready", async () => {
  const store = getOperationStore()
  const failInterrupted = vi.spyOn(store, "failInterrupted")
  const resolveSent = vi.spyOn(store, "resolveSent").mockResolvedValue()
  const node = {} as never
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () => root.render(<OperationsMount node={node} />))
  expect(failInterrupted).not.toHaveBeenCalled()
  expect(resolveSent).not.toHaveBeenCalled()

  h.status = "ready"
  await act(async () => root.render(<OperationsMount node={node} />))
  expect(failInterrupted).toHaveBeenCalledTimes(1)
  expect(resolveSent).toHaveBeenCalled()
  await act(async () => root.unmount())
})
