import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubEnv("VITE_ZKMONEY_API_URL", "https://api.test")
const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response())
const { bindSavedConsent } = await import("../../src/lib/bootConsent")
const { saveSetting } = await import("../../src/platform/storage/deviceKeys")
const { closeWalletStore } = await import("../../src/platform/storage/walletStorage")
const { reportBootFailure } = await import("../../src/ui/PxeBoot")
const { testCore } = await import("../support/page")
const deviceDb = testCore().database

const sent = () => fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).event)

beforeEach(() => fetchSpy.mockClear())

describe("a boot failure after the wallet database closes", () => {
  it.each([
    [true, ["pxe_boot_failed"]],
    [false, []],
  ])("reports under the consent saved at boot: %s", async (granted, events) => {
    await saveSetting(deviceDb, "analyticsConsent", granted)
    bindSavedConsent(testCore().device)
    await closeWalletStore()
    reportBootFailure(new Error("boom"), { bootStartedAt: undefined, attempts: 0 })
    expect(sent()).toEqual(events)
  })
})
