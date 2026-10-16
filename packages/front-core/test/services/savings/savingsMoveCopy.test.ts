import { describe, expect, it } from "vitest"
import {
  claimCheckCopy,
  savingsMoveLabel,
  shortHex,
} from "../../../src/core/services/savings/savingsMoveCopy"

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

describe("claimCheckCopy", () => {
  it("puts the known states in plain words", () => {
    expect(
      claimCheckCopy(
        `claim refused: No L1 to L2 message found for message hash 0x${"35".repeat(32)}`,
      ),
    ).toBe("Deposit found, waiting for it to reach Aztec")
    expect(claimCheckCopy("claim refused: Assertion failed: deposit already stored")).toBe(
      "Claimed",
    )
    expect(claimCheckCopy("claimed")).toBe("Claimed")
    expect(claimCheckCopy("deposit found, claim pending")).toBe("Deposit found, claim pending")
    expect(
      claimCheckCopy("no deposit on the destination portal yet, searched to block 11857570"),
    ).toBe("No deposit on the destination portal yet, searched to block 11857570")
  })

  it("shows any other refusal as a failure with its first line and hashes shortened", () => {
    expect(
      claimCheckCopy(
        `claim refused: Assertion failed: Balance too low for 0x${"5a".repeat(
          32,
        )}\n    at simulate`,
      ),
    ).toBe("Claim failed: Assertion failed: Balance too low for 0x5a5a…5a5a")
    expect(claimCheckCopy("claim refused: Error: Timeout awaiting the node")).toBe(
      "Claim failed: Timeout awaiting the node",
    )
  })
})
