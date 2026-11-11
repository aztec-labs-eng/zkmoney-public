// @vitest-environment node
/** A pre-boot navigation waits for the wallet's router, which applies it before it reads the URL. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPreBoot, type PreBoot } from "../../src/session/preBoot"

/** The tab's history entries, newest last. */
let entries: string[]
let preBoot: PreBoot
beforeEach(() => {
  preBoot = createPreBoot()
  entries = ["/"]
  vi.stubGlobal("history", {
    pushState: (_: unknown, __: string, url: string) => void entries.push(url),
    replaceState: (_: unknown, __: string, url: string) => void (entries[entries.length - 1] = url),
  })
  vi.stubGlobal("location", { pathname: "/" })
})
afterEach(() => vi.unstubAllGlobals())

describe("the pre-boot navigator before the wallet's router is up", () => {
  it("applies the last push once, as a new history entry", () => {
    preBoot.navigator.push("/claim")
    preBoot.navigator.push({ pathname: "/enter", search: "?next=%2Fpay" })
    preBoot.applyNavigation()
    preBoot.applyNavigation()
    expect(entries).toEqual(["/", "/enter?next=%2Fpay"])
  })

  it("applies a replace in place", () => {
    preBoot.navigator.replace("/enter")
    preBoot.applyNavigation()
    expect(entries).toEqual(["/enter"])
  })

  it("applies nothing when nothing navigated", () => {
    preBoot.applyNavigation()
    expect(entries).toEqual(["/"])
  })
})

describe("the pre-boot navigator once the wallet's router is up", () => {
  it("navigates through the bound router, and queues again once it unbinds", () => {
    const calls: [string, { replace: boolean }][] = []
    const unbind = preBoot.bind(
      ((to: string, options: { replace: boolean }) => void calls.push([to, options])) as never,
    )
    preBoot.navigator.replace("/enter")
    expect(calls).toEqual([["/enter", { replace: true }]])
    unbind()
    preBoot.navigator.push("/claim")
    preBoot.applyNavigation()
    expect(calls).toHaveLength(1)
    expect(entries).toEqual(["/", "/claim"])
  })
})
