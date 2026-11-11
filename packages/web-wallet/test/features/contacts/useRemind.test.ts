// @vitest-environment node
/** Dropping a request id from a remind state set keeps the set when the id is absent. */
import { describe, expect, it } from "vitest"
import { without } from "../../../src/features/contacts/useRemind"

describe("without", () => {
  it("returns the same set when the id is not in it", () => {
    const set = new Set(["a"])
    expect(without(set, "b")).toBe(set)
  })

  it("returns a new set without the id and leaves the old one as it was", () => {
    const set = new Set(["a", "b"])
    const next = without(set, "a")
    expect([...next]).toEqual(["b"])
    expect([...set]).toEqual(["a", "b"])
  })
})
