import { describe, expect, it } from "vitest"
import { savingsMoveLabel, shortHex } from "../../../src/core/services/savings/savingsMoveCopy"

describe("savingsMoveLabel", () => {
  it("names the move by its destination, never Ethereum", () => {
    expect(savingsMoveLabel("in")).toBe("Moving to Savings")
    expect(savingsMoveLabel("out")).toBe("Moving to Main Account")
  })
})

describe("shortHex", () => {
  it("shortens a long 0x hex to its ends and leaves short ones alone", () => {
    expect(shortHex(`hash 0x${"ab".repeat(32)} at 0x${"12".repeat(20)}`)).toBe(
      "hash 0xabab…abab at 0x1212…1212",
    )
    expect(shortHex("index 0x1234 and 0xabcdef")).toBe("index 0x1234 and 0xabcdef")
  })
})
