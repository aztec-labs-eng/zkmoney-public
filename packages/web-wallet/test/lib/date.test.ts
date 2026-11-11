// @vitest-environment node
/** A release date reads the same day for everyone in UTC, and an unreadable one stays as written. */
import { describe, expect, it } from "vitest"
import { formatLocalDate, formatUtcDate } from "../../src/lib/date"

describe("formatUtcDate", () => {
  it("names the UTC day, whatever the clock's zone", () => {
    expect(formatUtcDate("2026-11-05T23:30:00Z")).toMatch(/^Nov 5, 2026$/)
    expect(formatUtcDate("2026-11-06T00:30:00Z")).toMatch(/^Nov 6, 2026$/)
  })

  it("keeps a date it cannot read as written", () => {
    expect(formatUtcDate("soon")).toBe("soon")
    expect(formatLocalDate("soon")).toBe("soon")
  })
})
