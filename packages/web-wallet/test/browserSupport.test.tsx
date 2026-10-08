import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ walletBootLoaded: vi.fn() }))
vi.mock("../src/walletBoot", () => {
  h.walletBootLoaded()
  return { default: () => <div>Wallet boot</div> }
})

const FEATURES: [string, object, string, string, string][] = [
  ["Promise.withResolvers", Promise, "withResolvers", "/#h=sealed", ""],
  ["Web Locks", navigator, "locks", "/link#secret", "#secret"],
  ["Set.prototype.intersection", Set.prototype, "intersection", "/#h=sealed", ""],
]
const originals = FEATURES.map(([, target, key]) => Object.getOwnPropertyDescriptor(target, key)!)
const remove = (target: object, key: string) =>
  Object.defineProperty(target, key, { configurable: true, value: undefined })

const root = () => document.getElementById("root")!

const start = () =>
  act(async () => {
    await import("../src/main")
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

beforeEach(() => {
  vi.resetModules()
  h.walletBootLoaded.mockClear()
  vi.stubGlobal("fetch", vi.fn())
  document.body.innerHTML = '<div id="root"></div>'
})
afterEach(() => {
  document.body.innerHTML = ""
  history.replaceState(null, "", "/")
  FEATURES.forEach(([, target, key], i) => Object.defineProperty(target, key, originals[i]))
  vi.unstubAllGlobals()
})

describe("the wallet start", () => {
  it.each(FEATURES)(
    "refuses a browser without %s before the wallet loads",
    async (feature, target, key, url, hash) => {
      remove(target, key)
      history.replaceState(null, "", url)
      await start()
      const alert = root().querySelector('[role="alert"]')
      expect(alert?.textContent).toMatch(/Browser not supported.*update iOS to 17\.4 or later/)
      expect(alert?.textContent).toContain(feature)
      expect(root().querySelector("button")).toBeNull()
      expect(h.walletBootLoaded).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      expect(location.hash).toBe(hash)
    },
  )

  it("still opens the reset page in a browser it refuses", async () => {
    remove(Promise, "withResolvers")
    history.replaceState(null, "", "/reset")
    await start()
    expect(root().querySelector('[role="alert"]')).toBeNull()
    expect(h.walletBootLoaded).not.toHaveBeenCalled()
  })

  it("loads the wallet in a browser with every feature", async () => {
    await start()
    expect(root().textContent).toContain("Wallet boot")
  })
})
