// @vitest-environment node
import { describe, expect, it } from "vitest"
import { confirmsAtPick } from "../../../../src/features/deposit/ChooseNameSheet/nameChoice"

describe("a name sheet's pick", () => {
  it("confirms the tag only for a paid name on the deposit screen", () => {
    expect(confirmsAtPick("pay", "/deposit")).toBe(true)
    expect(confirmsAtPick("pay", "/settings")).toBe(false)
    expect(confirmsAtPick("past-user", "/deposit")).toBe(false)
    expect(confirmsAtPick("invite", "/deposit")).toBe(false)
  })
})
