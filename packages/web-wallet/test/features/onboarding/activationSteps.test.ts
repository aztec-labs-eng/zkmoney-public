import { describe, expect, it } from "vitest"
import {
  activationSteps,
  activationStepsLeft,
} from "../../../src/features/onboarding/activationSteps"

describe("activationSteps", () => {
  it("asks for the passkey before the deposit", () => {
    expect(activationSteps({ account: false, deposited: false })).toEqual([
      { id: "passkey", done: false },
      { id: "deposit", done: false, busy: false },
    ])
  })

  it.each([
    { account: false, left: 2 },
    { account: true, left: 1 },
  ])("leaves $left step(s) to do with account: $account", ({ account, left }) => {
    expect(activationStepsLeft(activationSteps({ account, deposited: false }))).toBe(left)
  })
})
