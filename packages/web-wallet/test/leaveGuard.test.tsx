/**
 * The leave prompt is the one thing between a running proof and a closed tab, so it is up exactly
 * while leaving would lose the transaction, and never otherwise.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fireEvent = vi.hoisted(() => vi.fn())
vi.mock("../src/lib/analytics", () => ({ fireEvent }))

import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import { trackSubmission } from "@obsidion/front-core"
import { runOperation } from "../src/features/operations/operations"
import { LeaveGuardMount } from "../src/features/operations/LeaveGuardMount"

let container: HTMLDivElement
let root: Root
let finish: (() => void) | undefined

beforeEach(async () => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<LeaveGuardMount />))
})

afterEach(async () => {
  await act(async () => finish?.())
  finish = undefined
  await act(async () => root.unmount())
  container.remove()
  fireEvent.mockClear()
})

function leave(): boolean {
  const event = new Event("beforeunload", { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

/** An operation that runs until `finish()`, with the flow's own hash save wired like a real flow. */
async function start(operationId: string, flow: "send" | "withdraw" = "withdraw") {
  let done!: Promise<void>
  await act(async () => {
    done = runOperation({ operationId, flow, summary: "$25" }, () => {
      const submission = trackSubmission(operationId, async () => {})
      return new Promise<void>((resolve) => {
        finish = () => void submission.stop().then(resolve)
      })
    })
  })
  return () => done
}

describe("LeaveGuardMount", () => {
  it("lets the page go when nothing is proving", () => {
    expect(leave()).toBe(false)
    expect(fireEvent).not.toHaveBeenCalled()
  })

  it("raises the prompt while a proof runs and reports it with the flow", async () => {
    await start("op-1")
    expect(leave()).toBe(true)
    expect(fireEvent).toHaveBeenCalledWith("proving_leave_prompted", { flow: "withdraw" })
  })

  it("drops the prompt once the flow's record holds the tx hash", async () => {
    await start("op-2", "send")
    expect(leave()).toBe(true)
    await act(async () => {
      provingProgress.emitStageStart(ProvingStage.Mining, "op-2", "0x" + "ab".repeat(32))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(leave()).toBe(false)
  })

  it("drops the prompt when the flow ends", async () => {
    const settled = await start("op-3")
    await act(async () => {
      finish?.()
      await settled()
    })
    finish = undefined
    expect(leave()).toBe(false)
  })
})
