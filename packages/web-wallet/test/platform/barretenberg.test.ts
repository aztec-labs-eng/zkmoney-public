import { afterEach, describe, expect, it, vi } from "vitest"
import { BackendType, Barretenberg, BarretenbergSync } from "@aztec-foundation/bb.js"
import { barretenbergWasm, iosSettings, warmSyncBackend } from "../../src/platform/barretenberg"

const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15"
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1"

function onDevice(userAgent: string, maxTouchPoints?: number) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
  Object.defineProperty(navigator, "maxTouchPoints", { value: maxTouchPoints, configurable: true })
}

async function bbSettings() {
  let maximum: number | undefined
  vi.spyOn(WebAssembly, "Memory").mockImplementation(function (descriptor) {
    maximum = descriptor.maximum
    throw new Error("memory read")
  })
  await BarretenbergSync.new({ backend: BackendType.Wasm }).catch(() => undefined)
  return { memory: { maximum }, srsSize: Barretenberg.prototype.getDefaultSrsSize() }
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, "maxTouchPoints")
})

describe("barretenbergWasm", () => {
  it("gives an iPad or a desktop-mode iPhone the settings bb.js gives an iPhone", async () => {
    onDevice(IPHONE, 5)
    const iphone = await bbSettings()
    onDevice(MAC, 5)
    expect(barretenbergWasm()).toEqual(iphone)
  })

  it.each([
    ["an iPhone", IPHONE, 5],
    ["a Mac", MAC, 0],
  ])("gives %s no memory or SRS settings", (_device, userAgent, touchPoints) => {
    onDevice(userAgent, touchPoints)
    expect(barretenbergWasm()).toEqual({})
  })

  it("gives a worker on an iPad the settings that its page sends", () => {
    onDevice(MAC, 5)
    const page = barretenbergWasm()
    const sent = iosSettings()
    onDevice(MAC)
    expect(barretenbergWasm()).toEqual({})
    expect(barretenbergWasm(sent)).toEqual(page)
  })

  it("is needed while bb.js withholds the iPhone settings from a Mac user agent with touch points", async () => {
    onDevice(IPHONE, 5)
    const iphone = await bbSettings()
    onDevice(MAC, 5)
    expect(await bbSettings()).not.toEqual(iphone)
  })
})

describe("warmSyncBackend", () => {
  it("starts bb.js on the page's options and keeps a failed start for the PXE to report", async () => {
    const start = vi.spyOn(BarretenbergSync, "initSingleton").mockRejectedValue(new Error("wasm"))
    await expect(warmSyncBackend()).resolves.toBeUndefined()
    expect(start).toHaveBeenCalledWith(barretenbergWasm())
    start.mockResolvedValue(undefined as never)
    await expect(warmSyncBackend()).resolves.toBeUndefined()
  })
})
