// The node sign-in suites' setup: a tab's storage, the boot config, and every flow ended after its test.
import { afterEach, beforeEach, vi } from "vitest"
import { closeSession } from "../../src/session/session"
import { openSignIn } from "./signIn"

/** Registers the suite's hooks; the returned `open` is `openSignIn`, ended after each test. */
export function signInSuite() {
  let opened: Awaited<ReturnType<typeof openSignIn>>[] = []
  beforeEach(() => {
    const tab = new Map<string, string>()
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => tab.get(key) ?? null,
      setItem: (key: string, value: string) => void tab.set(key, value),
      removeItem: (key: string) => void tab.delete(key),
    })
  })
  afterEach(() => {
    for (const { ended } of opened) ended.abort()
    opened = []
    closeSession()
    vi.unstubAllGlobals()
    delete (navigator as { userAgent?: string }).userAgent
  })
  return async (...args: Parameters<typeof openSignIn>) => {
    const flow = await openSignIn(...args)
    opened.push(flow)
    return flow
  }
}

/** A promise and the functions that settle it. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The browser reports `userAgent` until the test ends. */
export function asBrowser(userAgent: string) {
  Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true })
}

export const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/155.0.0.0 Safari/537.36"
