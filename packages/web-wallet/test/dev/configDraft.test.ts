import { beforeEach, expect, it, vi } from "vitest"
import {
  clearConfigDraft,
  configDraft,
  configDraftFetch,
  hasConfigDraft,
  saveConfigDraft,
} from "../../src/dev/configDraft"

beforeEach(() => sessionStorage.clear())

const PROFILE_URL = "https://preview.example/profiles/v6/current.json"
const FEATURES_URL = "https://preview.example/features/v6/current.json"

it("serves each saved draft only at its own URL and delegates other requests", async () => {
  const upstream = vi.fn(async () => new Response("live")) as typeof fetch
  saveConfigDraft("profile", PROFILE_URL, '{"profileId":"staging-v6"}')
  saveConfigDraft("features", PROFILE_URL, '{"features":{}}')

  const fetchWithDraft = configDraftFetch(upstream)
  expect(await (await fetchWithDraft(PROFILE_URL)).text()).toBe('{"profileId":"staging-v6"}')
  expect(await (await fetchWithDraft(FEATURES_URL)).text()).toBe('{"features":{}}')
  expect(
    await (await fetchWithDraft("https://preview.example/artifacts/current.json")).text(),
  ).toBe("live")
  expect(upstream).toHaveBeenCalledTimes(1)

  clearConfigDraft("features")
  expect(hasConfigDraft("features")).toBe(false)
  expect(hasConfigDraft("profile")).toBe(true)
  expect(await (await fetchWithDraft(FEATURES_URL)).text()).toBe("live")
})

it("ignores malformed stored drafts", () => {
  sessionStorage.setItem("webwallet.preview-config-draft", "{bad")
  expect(hasConfigDraft("profile")).toBe(false)
  expect(configDraft("profile", PROFILE_URL)).toBeUndefined()
})
