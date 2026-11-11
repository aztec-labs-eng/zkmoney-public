import { describe, expect, it } from "vitest"
import { privacyLevel, privacyRing } from "../../../src/features/withdraw/privacyRing"

const withdrew = { kind: "withdrew-before" as const }
const deposited = { kind: "linked-deposit" as const }

describe("privacyRing", () => {
  it.each([
    ["a fresh, unnamed address", { local: null, activity: false, named: false }, "High"],
    ["one with transactions", { local: null, activity: true, named: false }, "Medium"],
    [
      "one the chain read could not answer for",
      { local: null, activity: undefined, named: false },
      "Medium",
    ],
    ["a named one with transactions", { local: null, activity: true, named: true }, "Medium"],
    [
      "a named one withdrawn to before, with transactions",
      { local: withdrew, activity: true, named: true },
      "Medium",
    ],
    [
      "one that funded the account, however clear otherwise",
      { local: deposited, activity: false, named: false },
      "Low",
    ],
  ])("rates %s", (_, facts, level) => {
    expect(privacyLevel(privacyRing(facts))).toBe(level)
  })

  it("greys out a segment it could not read rather than calling it clear", () => {
    expect(privacyRing({ local: null, activity: undefined, named: false }).activity).toBe("unknown")
  })
})
