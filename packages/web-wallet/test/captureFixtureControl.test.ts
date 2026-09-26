import { beforeEach, expect, it, vi } from "vitest"

const demo = vi.hoisted(() => ({ enabled: true }))
vi.mock("../src/dev/demoFlag", () => ({ isDemoMode: () => demo.enabled }))
const { fixtureState } = await import("../scripts/ui-capture/fixtures/control")

beforeEach(() => {
  sessionStorage.clear()
  history.replaceState(null, "", "/")
  demo.enabled = true
})

it("requires both demo mode and explicit fixture selection, including a previously latched fixture", () => {
  expect(fixtureState()).toBeNull()
  history.replaceState(null, "", "/?flowFixture=success")
  demo.enabled = false
  expect(fixtureState()).toBeNull()
  demo.enabled = true
  expect(fixtureState()).toBe("success")
  history.replaceState(null, "", "/contacts/ada")
  expect(fixtureState()).toBe("success")
  demo.enabled = false
  expect(fixtureState()).toBeNull()
})

it("explicitly disables a latched fixture and rejects unknown controls", () => {
  history.replaceState(null, "", "/?flowFixture=pending")
  expect(fixtureState()).toBe("pending")
  history.replaceState(null, "", "/?flowFixture=off")
  expect(fixtureState()).toBeNull()
  history.replaceState(null, "", "/activity")
  expect(fixtureState()).toBeNull()
  history.replaceState(null, "", "/?flowFixture=unknown")
  expect(() => fixtureState()).toThrow("Unknown flow fixture")
})
