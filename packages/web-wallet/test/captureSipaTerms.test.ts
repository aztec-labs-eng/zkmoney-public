import { beforeEach, expect, it, vi } from "vitest"

const demo = vi.hoisted(() => ({ enabled: true }))
vi.mock("../src/dev/demoFlag", () => ({ isDemoMode: () => demo.enabled }))
const { readSipaPortalTerms } = await import("../scripts/ui-capture/fixtures/sipa-terms")
const { captureSipaPortalTerms, ORIGIN_PORTAL } = await import(
  "../scripts/ui-capture/fixtures/processing-origin"
)

const IMPLEMENTATION = "0x1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e" as const
const panel = () => readSipaPortalTerms(undefined as never, IMPLEMENTATION)

beforeEach(() => {
  sessionStorage.clear()
  demo.enabled = true
})

it("gives the funding panel the processing observer's terms for every origin fixture", async () => {
  // Before any retry click, so the failing lookup still fails for both.
  history.replaceState(null, "", "/?flowFixture=success&originFixture=failing")
  await expect(panel()).rejects.toThrow("portal lookup failed")
  await expect(captureSipaPortalTerms()).rejects.toThrow("portal lookup failed")

  const retry = document.createElement("button")
  retry.dataset.testid = "funding-capacity-retry"
  document.body.append(retry)
  retry.click()
  expect((await panel()).portal).toBe(ORIGIN_PORTAL)
  expect(await panel()).toEqual(await captureSipaPortalTerms())

  for (const query of ["originFixture=other", ""]) {
    history.replaceState(null, "", `/?flowFixture=success&${query}`)
    expect(await panel()).toEqual(await captureSipaPortalTerms())
  }
  history.replaceState(null, "", "/?flowFixture=success")
  expect((await panel()).portal).not.toBe(ORIGIN_PORTAL)
})
