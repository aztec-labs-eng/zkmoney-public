/** Where the wallet's features come from at boot. No feature's data matters here. */
import { describe, expect, it } from "vitest"
import { loadWalletFeatures } from "../../src/config/walletFeatures"

const PROFILE_URL = "https://cdn.mock.example/profiles/v6/current.json"
const FEATURES_URL = "https://cdn.mock.example/features/v6/current.json"
const EXPECTED = { profileId: "mock-v6", network: "testnet" } as const

const DOCUMENT = { schemaVersion: "1", ...EXPECTED, features: {} }

type Answer = Response | "offline"
function store(answer: Answer): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    asked.push(String(input))
    if (answer === "offline") throw new TypeError("network down")
    return answer
  }) as typeof fetch
  return { fetchImpl, asked }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("loadWalletFeatures", () => {
  it.each<[string, Answer, string | undefined, boolean]>([
    ["the served document", json(DOCUMENT), undefined, false],
    ["the baked copy when the store is unreachable", "offline", "UNREACHABLE", true],
    ["no features when the store says it has none", json({}, 404), "NOT_FOUND", false],
    [
      "no features for another profile's document",
      json({ ...DOCUMENT, profileId: "mock-other-v6" }),
      "IDENTITY_MISMATCH",
      false,
    ],
  ])("boots on %s", async (_, answer, issue, bootedFromBaked) => {
    const { fetchImpl, asked } = store(answer)
    const loaded = await loadWalletFeatures({
      profileUrl: PROFILE_URL,
      expected: EXPECTED,
      baked: DOCUMENT,
      fetchImpl,
    })
    expect(asked).toEqual([FEATURES_URL])
    expect(loaded.issue?.code).toBe(issue)
    expect(loaded.bootedFromBaked).toBe(bootedFromBaked)
  })

  it("boots on the baked copy without fetching when the host asks", async () => {
    const { fetchImpl, asked } = store("offline")
    const loaded = await loadWalletFeatures({
      profileUrl: PROFILE_URL,
      expected: EXPECTED,
      baked: DOCUMENT,
      forceBaked: true,
      fetchImpl,
    })
    expect(asked).toEqual([])
    expect(loaded).toMatchObject({ bootedFromBaked: true, issue: undefined })
  })

  it("turns every feature off for a profile URL no features document derives from", async () => {
    const { fetchImpl, asked } = store("offline")
    const loaded = await loadWalletFeatures({
      profileUrl: "https://host.mock.example/my-profile.json",
      expected: EXPECTED,
      baked: DOCUMENT,
      fetchImpl,
    })
    expect(asked).toEqual([])
    expect(loaded).toMatchObject({ features: {}, issue: { code: "NO_URL" } })
  })
})
