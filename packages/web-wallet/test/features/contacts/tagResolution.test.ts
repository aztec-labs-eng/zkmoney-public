// @vitest-environment node
/** The page's tag resolutions share a registry read still running, and read again once it fails. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { testPage } from "../../support/page"

afterEach(() => vi.unstubAllGlobals())

describe("tagResolution", () => {
  it("shares a running read, fails with it, and reads again on the next read", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("network down")
    })
    vi.stubGlobal("fetch", fetch)
    const { chain } = testPage()
    const first = chain.tagResolution("mina")
    expect(chain.tagResolution("MINA")).toBe(first)
    expect(chain.tagResolution("ada")).not.toBe(first)
    await expect(first.read()).rejects.toThrow()
    const reads = fetch.mock.calls.length
    await expect(chain.tagResolution("mina").read()).rejects.toThrow()
    expect(fetch.mock.calls.length).toBeGreaterThan(reads)
  })
})
