// @vitest-environment node
/** A creation sheet's own probes, over the real auth service with its laptop read standing in. */
import { afterEach, describe, expect, it } from "vitest"
import type { LaptopCreation } from "@obsidion/passkey-web"
import {
  openCreationProbe,
  PHONE_CREATION,
  sameList,
} from "../../../src/features/identity/ceremonyGate"
import { testAuth } from "../../support/page"

const ROW: LaptopCreation = {
  local: true,
  os: "macos",
  row: "macChrome",
  managers: ["apple"],
  withdrawn: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let ended: AbortController | undefined
afterEach(() => ended?.abort())

function sheet(laptopCreation: () => Promise<LaptopCreation>) {
  const probe = openCreationProbe(testAuth({ laptopCreation }))
  ended = new AbortController()
  probe.start(ended.signal)
  return probe
}

describe("the creation sheet's probes", () => {
  it("answer once both have landed", async () => {
    const laptop = deferred<LaptopCreation>()
    const probe = sheet(() => laptop.promise)
    await flush()
    expect(probe.answers.get()).toBeUndefined()
    laptop.resolve(ROW)
    await flush()
    expect(probe.answers.get()).toEqual({ reach: "unknown", creation: ROW })
  })

  it("read a failed laptop probe as phone creation", async () => {
    const probe = sheet(() => Promise.reject(new Error("no answer")))
    await flush()
    expect(probe.answers.get()).toEqual({ reach: "unknown", creation: PHONE_CREATION })
  })

  it("drop the answers of a showing that ended", async () => {
    const laptop = deferred<LaptopCreation>()
    const probe = sheet(() => laptop.promise)
    ended?.abort()
    laptop.resolve(ROW)
    await flush()
    expect(probe.answers.get()).toBeUndefined()
  })
})

describe("sameList", () => {
  it("matches the same managers in the same order only", () => {
    expect(sameList(["Apple", "1Password"], ["Apple", "1Password"])).toBe(true)
    expect(sameList(["Apple", "1Password"], ["1Password", "Apple"])).toBe(false)
    expect(sameList(["Apple"], ["Apple", "1Password"])).toBe(false)
  })
})
