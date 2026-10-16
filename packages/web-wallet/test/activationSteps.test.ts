import { describe, expect, it } from "vitest"
import { activationSteps } from "../src/features/onboarding/activationSteps"

describe("activationSteps", () => {
  it("asks for the passkey before the deposit", () => {
    expect(activationSteps({ account: false, deposited: false })).toEqual([
      { id: "passkey", done: false },
      { id: "deposit", done: false, busy: false },
    ])
  })

  it("runs the activation once funds are in", () => {
    const steps = activationSteps({ account: true, deposited: true })
    expect(steps.map((s) => s.done)).toEqual([true, false])
    expect(steps[1].busy).toBe(true)
  })

  it("a golden ticket is activating", () => {
    const steps = activationSteps({ account: true, deposited: false, ticket: true })
    expect(steps.map((s) => s.done)).toEqual([true, false])
    expect(steps[1].busy).toBe(true)
  })
})
