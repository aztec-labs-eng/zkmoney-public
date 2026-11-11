// @vitest-environment node
/** The pay hint for a recipient still on an old version names that recipient. */
import { describe, expect, it } from "vitest"
import { recipientNotUpgradedCopy } from "../../../src/features/migration/upgradeCopy"

describe("recipientNotUpgradedCopy.payHint", () => {
  it("names the recipient by tag", () => {
    expect(recipientNotUpgradedCopy.payHint("mina")).toContain("@mina")
    expect(recipientNotUpgradedCopy.payHint("mina")).not.toBe(
      recipientNotUpgradedCopy.requestHint("mina"),
    )
  })
})
