/**
 * The config profile and its features document are requested as the page starts; the boot's first
 * request for each takes that response, and its deadline still applies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prefetchProfile } from "../../src/config/profilePrefetch"

const URL = "https://cdn.example.test/profiles/v5/current.json"
const FEATURES_URL = "https://cdn.example.test/features/v5/current.json"
const env = { VITE_CONFIG_PROFILE_URL: URL }
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => new Response("{}"))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("prefetchProfile", () => {
  it("requests the profile and its features once each, and the boot's requests take them", async () => {
    const profileFetch = prefetchProfile(env)!
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([URL, FEATURES_URL])
    for (const url of [URL, FEATURES_URL]) {
      const response = await profileFetch(url, { headers: { accept: "application/json" } })
      expect(await response.text()).toBe("{}")
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // A later request is a request of its own.
    await profileFetch(URL)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("prefetches no features for a profile URL none derives from", () => {
    prefetchProfile({ VITE_CONFIG_PROFILE_URL: "https://cdn.example.test/elsewhere.json" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("leaves any other request to fetch", async () => {
    const profileFetch = prefetchProfile(env)!
    await profileFetch("https://cdn.example.test/artifacts/manifest.json")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("aborts the prefetch when the boot's deadline does", async () => {
    const profileFetch = prefetchProfile(env)!
    const prefetchSignal = fetchMock.mock.calls[0][1].signal as AbortSignal
    const deadline = new AbortController()
    void profileFetch(URL, { signal: deadline.signal })
    expect(prefetchSignal.aborted).toBe(false)
    deadline.abort()
    expect(prefetchSignal.aborted).toBe(true)
  })

  it("is not made by a desktop build, whose launcher may name another profile", () => {
    expect(prefetchProfile({ ...env, VITE_DESKTOP_BUILD: "true" })).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
