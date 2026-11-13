/**
 * The keep-open notice follows the operation that binds the tab: up from its start, through its proof
 * and hand-off, then sent for a moment once the hash is saved. A failure leaves the report to the flow
 * and the bell.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WalletError, type OperationEvent } from "@obsidion/front-core"
import { activeNamespace, closeSession, switchSession } from "../../../src/session/session"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import { KeepOpenNotice } from "../../../src/features/operations/KeepOpenNotice/KeepOpenNotice"
import {
  runOperation,
  SAFE_SHOWN_MS,
  type OperationHandle,
} from "../../../src/features/operations/operations"
import { testCore, testPage } from "../../support/page"
import { testSession } from "../../support/operations"

let container: HTMLDivElement
let root: Root
/** The running flow: its handle, how it ends, and what `runOperation` returns. */
let flow: { op: OperationHandle; end: (err?: Error) => void; done: Promise<void> } | undefined

beforeEach(async () => {
  localStorage.clear()
  switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage()))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<KeepOpenNotice />))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await act(async () => flow?.end())
  flow = undefined
  await act(async () => root.unmount())
  container.remove()
  closeSession()
})

const notice = () => container.querySelector<HTMLElement>("[data-testid=keep-open-notice]")
const line = () => notice()?.getAttribute("data-line") ?? null

/** A send that runs until `flow.end`. */
async function start(operationId: string) {
  let op: OperationHandle | undefined
  let end!: (err?: Error) => void
  const done = runOperation(testSession(), { operationId, flow: "send", summary: "$25" }, (h) => {
    op = h
    return new Promise<void>((resolve, reject) => {
      end = (err) => (err ? reject(err) : resolve())
    })
  })
  await act(async () => {
    while (!op) await new Promise((r) => setTimeout(r, 0))
  })
  flow = { op: op!, end, done }
}

const apply = (event: OperationEvent) =>
  act(async () => void (await testSession().operations.apply(flow!.op.operationId, event)))

/** Ends the flow with `err`, which `runOperation` throws on. */
const fail = (err: Error) =>
  act(async () => {
    flow!.end(err)
    await expect(flow!.done).rejects.toThrow()
  })

describe("KeepOpenNotice", () => {
  it("shows nothing while nothing binds the tab", () => {
    expect(line()).toBeNull()
  })

  it("keeps the tab from the start, through the proof and the hand-off, and is safe once sent", async () => {
    await start("op-keep")
    expect(line()).toBe("keep")
    await apply({ type: "proving", at: Date.now() })
    await apply({ type: "handedOff", at: Date.now() })
    expect(line()).toBe("keep")
    await act(async () => flow!.op.sent(`0x${"ab".repeat(32)}`))
    expect(line()).toBe("safe")
    await act(async () => {
      flow!.end()
      await flow!.done
    })
    expect(line()).toBe("safe")
  })

  it("fades out over the moment it shows once sent, then goes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await start("op-gone")
    await act(async () => flow!.op.sent(`0x${"ab".repeat(32)}`))
    expect(line()).toBe("safe")
    expect(notice()?.style.getPropertyValue("--shown")).toBe(`${SAFE_SHOWN_MS}ms`)
    await act(async () => void (await vi.advanceTimersByTimeAsync(SAFE_SHOWN_MS - 1_500)))
    expect(line()).toBe("safe")
    await act(async () => void (await vi.advanceTimersByTimeAsync(2_500)))
    expect(line()).toBeNull()
  })

  it("shrinks to a strip when tapped on a phone, and shows the sent card in full", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: true,
      media,
      addEventListener() {},
      removeEventListener() {},
    }))
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<KeepOpenNotice />))
    await start("op-shrink")
    expect(notice()?.hasAttribute("data-shrunk")).toBe(false)
    await act(async () => notice()!.click())
    expect(notice()?.hasAttribute("data-shrunk")).toBe(true)
    expect(line()).toBe("keep")
    await act(async () => flow!.op.sent(`0x${"ab".repeat(32)}`))
    expect(line()).toBe("safe")
    expect(notice()?.hasAttribute("data-shrunk")).toBe(false)
  })

  it("leaves a failure to the flow and the bell", async () => {
    await start("op-fail")
    await apply({ type: "proving", at: Date.now() })
    await fail(new WalletError("unknown", "proof failed"))
    expect(line()).toBeNull()
  })

  it("leaves a flow the user cancelled before anything was sent", async () => {
    await start("op-cancel")
    await fail(new Error("Cancelled"))
    expect(line()).toBeNull()
  })
})
