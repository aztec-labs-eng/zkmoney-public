import { describe, expect, it } from "vitest"
import { captureLandingSource, landingSource, trafficSource } from "../src/lib/trafficSource"

const WALLET = "https://app.zk.money/claim"

describe("trafficSource", () => {
  it.each([
    ["email", `${WALLET}?utm_source=email`, ""],
    ["x-post", `${WALLET}?utm_source=x-post`, ""],
    ["x-ads", `${WALLET}?utm_source=x-ads`, "https://t.co/abc"],
    ["invite", `${WALLET}?utm_source=invite`, ""],
    ["invite", `${WALLET}?invite=ab12`, "https://x.com/someone"],
    ["x-post", WALLET, "https://x.com/someone/status/1"],
    ["x-post", `${WALLET}?utm_source=newsletter`, "https://t.co/abc"],
    ["direct", `${WALLET}?utm_source=newsletter`, "https://example.com/"],
    ["direct", `${WALLET}?utm_source=direct`, ""],
    ["direct", WALLET, ""],
    ["direct", "not a url", "not a url"],
  ])("resolves %s from %s with referrer %s", (source, url, referrer) => {
    expect(trafficSource(url, referrer)).toBe(source)
  })

  it("keeps the landing source after a redirect drops the query", () => {
    window.history.replaceState(null, "", "/?utm_source=x-ads")
    captureLandingSource()
    window.history.replaceState(null, "", "/claim")
    expect(landingSource()).toBe("x-ads")
  })
})
