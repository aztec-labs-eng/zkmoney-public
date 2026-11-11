// @vitest-environment node
/** A request row's amount face and the one timestamp shape every activity row shows. */
import { formatDateLabel, formatTimeLabel } from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import { requestAmountLabel, rowTimestamp, shortAddr, usdBalance } from "../../src/ui/format"

describe("requestAmountLabel", () => {
  it("shows a fixed amount as grouped dollars, and no figure for an any-amount link", () => {
    expect(requestAmountLabel(1234.5)).toBe(usdBalance("1234.5"))
    expect(requestAmountLabel(0)).not.toMatch(/\$/)
  })
})

describe("rowTimestamp", () => {
  it("joins the date label and the time label", () => {
    const at = Date.UTC(2026, 1, 3, 11, 15)
    const stamp = rowTimestamp(at)
    expect(stamp.startsWith(formatDateLabel(at))).toBe(true)
    expect(stamp.endsWith(formatTimeLabel(at))).toBe(true)
  })
})

describe("shortAddr", () => {
  it("keeps a value of ten characters or fewer whole, and cuts a longer one to 6 and 4", () => {
    expect(shortAddr("0x12345678")).toBe("0x12345678")
    expect(shortAddr("0x1234567890abcdef")).toBe("0x1234…cdef")
  })
})
