import React, { act, StrictMode, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fireEvent = vi.hoisted(() => vi.fn())
vi.mock("../src/lib/analytics", () => ({ fireEvent, failureCode: vi.fn() }))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))

import { useProvingOutcome } from "../src/ui/hooks"

let outcome: ReturnType<typeof useProvingOutcome>
function Probe() {
  outcome = useProvingOutcome("send")
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  fireEvent.mockClear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (el: React.ReactElement) => act(() => root.render(el))
const leave = () => render(<></>)
const pagehide = () => act(() => window.dispatchEvent(new Event("pagehide")))

describe("useProvingOutcome", () => {
  it("reports leaving an unfinished attempt with its latest stage", () => {
    render(<Probe />)
    outcome.start("building")
    outcome.updateStage("proving")
    leave()
    expect(fireEvent).toHaveBeenCalledTimes(1)
    expect(fireEvent).toHaveBeenCalledWith("proving_cancelled", {
      flow: "send",
      stage: "proving",
    })
  })

  it("finishes synchronously when the parent removes the screen in the same event", () => {
    function Flow({ onDone }: { onDone: () => void }) {
      const tracker = useProvingOutcome("send")
      return (
        <button
          onClick={() => {
            tracker.start("proving")
            tracker.finish()
            onDone()
          }}
        >
          Finish
        </button>
      )
    }
    function Parent() {
      const [open, setOpen] = useState(true)
      return open ? <Flow onDone={() => setOpen(false)} /> : null
    }
    render(<Parent />)
    act(() => container.querySelector("button")!.click())
    expect(container.textContent).toBe("")
    pagehide()
    expect(fireEvent).not.toHaveBeenCalled()
  })

  it("does not resume tracking on rerenders or progress updates after a handoff", () => {
    render(<Probe />)
    outcome.start("proving")
    outcome.finish()
    render(<Probe />)
    outcome.updateStage("submitting")
    pagehide()
    leave()
    expect(fireEvent).not.toHaveBeenCalled()
  })

  it("reports an accepted cancel once even if the screen later closes", () => {
    render(<Probe />)
    outcome.start("building")
    outcome.cancel()
    outcome.cancel()
    pagehide()
    leave()
    expect(fireEvent).toHaveBeenCalledTimes(1)
    expect(fireEvent).toHaveBeenCalledWith("proving_cancelled", {
      flow: "send",
      stage: "building",
    })
  })

  it("reports page abandonment once without also reporting cancellation", () => {
    render(<Probe />)
    outcome.start("proving")
    outcome.updateStage("submitting")
    pagehide()
    pagehide()
    leave()
    expect(fireEvent).toHaveBeenCalledTimes(1)
    expect(fireEvent).toHaveBeenCalledWith("proving_abandoned", {
      flow: "send",
      stage: "submitting",
    })
  })

  it("tracks retries independently after a cancellation or a finished attempt", () => {
    render(<Probe />)
    outcome.start("building")
    outcome.cancel()
    outcome.start("proving")
    outcome.finish()
    outcome.start("resolving")
    pagehide()
    expect(fireEvent.mock.calls).toEqual([
      ["proving_cancelled", { flow: "send", stage: "building" }],
      ["proving_abandoned", { flow: "send", stage: "resolving" }],
    ])
  })

  it("stays silent before an attempt, including StrictMode effect cleanup", () => {
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    )
    pagehide()
    leave()
    expect(fireEvent).not.toHaveBeenCalled()
  })
})
