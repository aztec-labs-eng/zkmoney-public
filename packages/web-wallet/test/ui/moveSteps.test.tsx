// @vitest-environment node
/** The shared step list of a move: its rows, its approvals-left header, its warning and note. */
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { fmt } from "../../src/lib/fmt"
import { approvalsLeft, MoveSteps } from "../../src/ui/MoveSteps/MoveSteps"
import copy from "../../src/ui/MoveSteps/MoveSteps.copy"

const CAPTION = "caption"
const WARNING = "held"
const NOTE = "note"
const ROWS = [
  { label: "first", state: "done" },
  { label: "second", state: "current", detail: copy.confirming },
  { label: "third", state: "todo" },
] as const

describe("approvalsLeft", () => {
  it("counts the approvals left, as an upper bound where the count is one", () => {
    expect(approvalsLeft(1)).toBe(copy.left.one)
    expect(approvalsLeft(3)).toBe(fmt(copy.left.count, { count: 3 }))
    expect(approvalsLeft(3, true)).toBe(fmt(copy.left.upTo, { count: 3 }))
  })

  it("says nothing when none are left or the number is unknown", () => {
    expect(approvalsLeft(0)).toBe("")
    expect(approvalsLeft(undefined, true)).toBe("")
  })
})

describe("MoveSteps", () => {
  it("lists the rows in order under the caption and the header", () => {
    const html = renderToStaticMarkup(
      <MoveSteps caption={CAPTION} header={approvalsLeft(2)} rows={ROWS} />,
    )

    expect(html).toContain(CAPTION)
    expect(html).toContain(fmt(copy.left.count, { count: 2 }))
    const at = ROWS.map(({ label }) => html.indexOf(label))
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect(html).toContain(copy.confirming)
    expect(html.match(/aria-current="step"/g)).toHaveLength(1)
  })

  it("shows a warning as an alert while no row works, and the caller's note", () => {
    const rows = ROWS.map((row) => ({
      ...row,
      state: row.state === "current" ? "todo" : row.state,
    }))
    const html = renderToStaticMarkup(
      <MoveSteps caption={CAPTION} rows={rows} warning={WARNING} note={NOTE} />,
    )

    expect(html).not.toContain("aria-current")
    expect(html).toMatch(new RegExp(`role="alert"[^>]*>${WARNING}<`))
    expect(html).toContain(NOTE)
  })
})
