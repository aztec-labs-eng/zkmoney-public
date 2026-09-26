import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { signInWithGoogleIdToken } from "../src/features/paylink/googleAuth"

const opened: string[] = []
beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  opened.length = 0
  vi.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url))
    return { close: vi.fn() } as unknown as Window
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})
const stateAt = (i: number) => new URL(opened[i]!).searchParams.get("state")!
function deliver(state: string, token: string) {
  const key = `obsidion-google-callback:${state}`
  localStorage.setItem(key, JSON.stringify({ state, idToken: token, createdAt: Date.now() }))
  window.dispatchEvent(new StorageEvent("storage", { key }))
}

it("aborts an abandoned attempt without consuming the replacement callback", async () => {
  const abort = new AbortController()
  const first = signInWithGoogleIdToken("1", "client", undefined, abort.signal)
  const cancelled = expect(first).rejects.toThrow(/cancelled/)
  abort.abort()
  await cancelled
  const second = signInWithGoogleIdToken("2", "client")
  deliver(stateAt(1), "replacement-token")
  await expect(second).resolves.toBe("replacement-token")
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})

it("isolates concurrent attempts, including errors and cleanup", async () => {
  const first = signInWithGoogleIdToken("1", "client")
  const second = signInWithGoogleIdToken("2", "client")
  deliver(stateAt(1), "second-token")
  await expect(second).resolves.toBe("second-token")
  deliver(stateAt(0), "first-token")
  await expect(first).resolves.toBe("first-token")
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})

it("cleans expired orphan callbacks without deleting a live attempt", async () => {
  const expired = "obsidion-google-callback:expired"
  const live = "obsidion-google-callback:live"
  localStorage.setItem(expired, JSON.stringify({ createdAt: Date.now() - 6 * 60_000 }))
  localStorage.setItem(live, JSON.stringify({ createdAt: Date.now() }))
  const abort = new AbortController()
  const pending = signInWithGoogleIdToken("1", "client", undefined, abort.signal)
  const cancelled = expect(pending).rejects.toThrow(/cancelled/)
  expect(localStorage.getItem(expired)).toBeNull()
  expect(localStorage.getItem(live)).not.toBeNull()
  abort.abort()
  await cancelled
})
