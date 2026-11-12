/** A boot chunk whose download fails reloads the page, twice at most per tab, and other failures throw. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { clearDownloadReloads, importOrReload } from "../../src/platform/moduleDownload"

const DOWNLOAD = () =>
  new TypeError("Failed to fetch dynamically imported module: /assets/walletBoot.js")

afterEach(() => clearDownloadReloads())

describe("importOrReload", () => {
  it("returns the module when it loads", async () => {
    const reload = vi.fn()
    await expect(importOrReload(() => Promise.resolve("boot"), reload)).resolves.toBe("boot")
    expect(reload).not.toHaveBeenCalled()
  })

  it("reloads after a failed download twice, then throws", async () => {
    const reload = vi.fn()
    void importOrReload(() => Promise.reject(DOWNLOAD()), reload)
    void importOrReload(() => Promise.reject(DOWNLOAD()), reload)
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2))
    await expect(importOrReload(() => Promise.reject(DOWNLOAD()), reload)).rejects.toThrow(
      "Failed to fetch dynamically imported module",
    )
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it("reloads after a failed stylesheet download", async () => {
    const reload = vi.fn()
    const css = new Error("Unable to preload CSS for /assets/walletBoot.css")
    void importOrReload(() => Promise.reject(css), reload)
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
  })

  it("throws any other failure without a reload", async () => {
    const reload = vi.fn()
    await expect(importOrReload(() => Promise.reject(new Error("boom")), reload)).rejects.toThrow(
      "boom",
    )
    expect(reload).not.toHaveBeenCalled()
  })
})
