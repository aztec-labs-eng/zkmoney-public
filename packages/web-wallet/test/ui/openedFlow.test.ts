// @vitest-environment node
/** A screen reports its opening once per mount, whatever the starts. */
import { describe, expect, it } from "vitest"
import { openedFlow } from "../../src/ui/useScreenFlow"

describe("openedFlow", () => {
  it("reports at the first start, never at build", () => {
    const sink: string[] = []
    const flow = openedFlow(() => sink.push("withdraw_opened"))
    expect(sink).toEqual([])
    flow.start(new AbortController().signal)
    expect(sink).toEqual(["withdraw_opened"])
  })

  it("reports once when StrictMode aborts the first start and starts again", () => {
    const sink: string[] = []
    const flow = openedFlow(() => sink.push("withdraw_opened"))
    const first = new AbortController()
    flow.start(first.signal)
    first.abort()
    flow.start(new AbortController().signal)
    expect(sink).toEqual(["withdraw_opened"])
  })
})
