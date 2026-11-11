// @vitest-environment node
/** The Google popup's result reaches the attempt that opened it over Node's `BroadcastChannel`. */
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  GoogleSignInCancelled,
  relayGoogleCallback,
  signInWithGoogleIdToken,
} from "../../../../src/features/paylink/googleRelay"

const opened: string[] = []
const popups: { close: () => void }[] = []
beforeEach(() => {
  opened.length = 0
  popups.length = 0
  vi.stubGlobal("location", { origin: "https://wallet.test" })
  vi.stubGlobal("window", {
    open: (url: string) => {
      opened.push(url)
      const popup = { close: vi.fn() }
      popups.push(popup)
      return popup
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const stateAt = (i: number) => new URL(opened[i]!).searchParams.get("state")!

it("hands each concurrent attempt its own token, and closes its popup", async () => {
  const first = signInWithGoogleIdToken("1", "client")
  const second = signInWithGoogleIdToken("2", "client")
  expect(relayGoogleCallback(`#state=${stateAt(1)}&id_token=second-token`)).toBe(true)
  await expect(second).resolves.toBe("second-token")
  relayGoogleCallback(`#state=${stateAt(0)}&id_token=first-token`)
  await expect(first).resolves.toBe("first-token")
  expect(popups.every((p) => vi.mocked(p.close).mock.calls.length === 1)).toBe(true)
})

it("rejects an attempt Google answered with an error or without a token", async () => {
  const denied = signInWithGoogleIdToken("1", "client")
  relayGoogleCallback(`#state=${stateAt(0)}&error=access_denied`)
  await expect(denied).rejects.toThrow("access_denied")
  const empty = signInWithGoogleIdToken("2", "client")
  relayGoogleCallback(`#state=${stateAt(1)}`)
  await expect(empty).rejects.toThrow(/id_token/)
})

it("relays nothing for a callback that names no attempt", () => {
  expect(relayGoogleCallback("#id_token=t")).toBe(false)
})

it("ends as cancelled on abort, and times out an attempt nothing answers", async () => {
  vi.useFakeTimers()
  const abort = new AbortController()
  const aborted = signInWithGoogleIdToken("1", "client", undefined, abort.signal)
  abort.abort()
  await expect(aborted).rejects.toBeInstanceOf(GoogleSignInCancelled)
  const silent = signInWithGoogleIdToken("2", "client")
  const outcome = expect(silent).rejects.toThrow(/timed/)
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  await outcome
  expect(vi.getTimerCount()).toBe(0)
})

it("fails with a coded error when the browser blocks the popup", async () => {
  vi.stubGlobal("window", { open: () => null })
  await expect(signInWithGoogleIdToken("1", "client")).rejects.toMatchObject({ code: "unknown" })
})
