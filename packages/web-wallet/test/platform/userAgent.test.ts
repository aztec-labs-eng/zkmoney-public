// @vitest-environment node
/** The page's browser claims and phone reach: probed once, when a view first reads them. */
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { phoneReach, userAgentClaims } from "../../src/platform/userAgent"
import { testQuery } from "../support/query"

const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const asked: ((values: { platformVersion: string }) => void)[] = []
const answer = (values: { platformVersion: string }) => asked.forEach((resolve) => resolve(values))
const getHighEntropyValues = vi.fn(
  () => new Promise<{ platformVersion: string }>((resolve) => asked.push(resolve)),
)

beforeEach(() => {
  vi.useFakeTimers()
  asked.length = 0
  getHighEntropyValues.mockClear()
  vi.stubGlobal("navigator", {
    userAgent: MAC,
    userAgentData: { platform: "macOS", brands: [], getHighEntropyValues },
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("probes nothing until a view subscribes", () => {
  const claims = userAgentClaims(testQuery())
  expect(claims.get()).toBeUndefined()
  expect(getHighEntropyValues).not.toHaveBeenCalled()
  claims.subscribe(() => {})
  expect(getHighEntropyValues).toHaveBeenCalled()
})

it("takes the string's claims after a bounded wait, and Client Hints' once they answer late", async () => {
  const claims = userAgentClaims(testQuery())
  claims.subscribe(() => {})
  await vi.advanceTimersByTimeAsync(1_000)
  expect(claims.get()).toMatchObject({ osFamily: "macos" })
  expect(claims.get()?.osVersionFromHints).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
  answer({ platformVersion: "26.0.0" })
  await vi.advanceTimersByTimeAsync(0)
  expect(claims.get()).toMatchObject({ osVersionFromHints: true })
})

it("probes the phone reach once per page, and reads a failed probe as unknown", async () => {
  const probePhoneReach = vi.fn(async () => {
    throw new Error("no bluetooth")
  })
  const reach = phoneReach(testQuery(), { probePhoneReach })
  vi.spyOn(console, "warn").mockImplementation(() => {})
  reach.subscribe(() => {})()
  await vi.advanceTimersByTimeAsync(0)
  reach.subscribe(() => {})
  await vi.advanceTimersByTimeAsync(0)
  expect(reach.get()).toMatchObject({ status: "ready", value: "unknown" })
  expect(probePhoneReach).toHaveBeenCalledTimes(1)
})
