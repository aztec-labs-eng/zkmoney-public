// @vitest-environment node
/** A reminder blocks the next one for the remind interval, measured from when it was sent. */
import { describe, expect, it } from "vitest"
import { REMIND_INTERVAL_MS, remindedRecently } from "../../src/engine/requests"

describe("remindedRecently", () => {
  const sent = 1_800_000_000_000

  it("blocks a reminder inside the interval and allows one once it ends", () => {
    expect(remindedRecently(sent, sent + REMIND_INTERVAL_MS - 1)).toBe(true)
    expect(remindedRecently(sent, sent + REMIND_INTERVAL_MS)).toBe(false)
  })

  it("allows a reminder for a request never reminded", () => {
    expect(remindedRecently(undefined, sent)).toBe(false)
  })
})
