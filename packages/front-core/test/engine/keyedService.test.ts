// @vitest-environment node
import { describe, expect, it } from "vitest"
import { valueOf } from "../../src/engine/service"
import { keyedService } from "../../src/engine/service"
import { fakeClock, flush, later } from "./taskTable"

const FAILED = new Error("create failed")

/** Services per (account, token) over one wallet input, and what each built and disposed. */
function tokens() {
  const wallet = later<string>("wallet")
  const built: string[] = []
  const disposed: string[] = []
  let failNext = false
  const at = keyedService(
    "token",
    {
      from: [wallet.service],
      retry: "manual",
      key: (account: { address: string }, token: string) => [account.address, token],
      dispose: (value: string) => void disposed.push(value),
    },
    async ([account, token], [w]) => {
      if (failNext) {
        failNext = false
        throw FAILED
      }
      const value = `${w}:${account.address}:${token}`
      built.push(value)
      return value
    },
  )
  return { wallet, at, built, disposed, failNextBuild: () => void (failNext = true) }
}

describe("keyedService", () => {
  fakeClock()

  it("builds nothing until a key is asked for, then one service per key", async () => {
    const { wallet, at, built } = tokens()
    wallet.ready("w1")
    await flush()
    expect(built).toEqual([])

    const a = at({ address: "0xA" }, "0xEE")
    expect(at({ address: "0xa" }, "0xee")).toBe(a)
    expect(at({ address: "0xb" }, "0xee")).not.toBe(a)
    await flush()
    expect(valueOf(a)).toBe("w1:0xA:0xEE")
    expect(built).toHaveLength(2)
  })

  it("builds each again over a new input, and disposes what it replaced", async () => {
    const { wallet, at, disposed } = tokens()
    wallet.ready("w1")
    const a = at({ address: "0xa" }, "0xt")
    await flush()
    wallet.ready("w2")
    await flush()
    expect(valueOf(a)).toBe("w2:0xa:0xt")
    expect(disposed).toEqual(["w1:0xa:0xt"])
  })

  it("builds a failed one again on its next call, and closes every one", async () => {
    const { wallet, at, failNextBuild, disposed } = tokens()
    wallet.ready("w1")
    failNextBuild()
    const a = at({ address: "0xa" }, "0xt")
    await expect(a.ready()).rejects.toBe(FAILED)
    expect(await at({ address: "0xa" }, "0xt").ready()).toBe("w1:0xa:0xt")

    at.close()
    await flush()
    expect(a.get().status).toBe("failed")
    expect(disposed).toEqual(["w1:0xa:0xt"])
  })

  it("is one service with no key, made on the first call", async () => {
    let builds = 0
    const one = keyedService("one", { retry: "manual" }, async () => ++builds)
    await flush()
    expect(builds).toBe(0)
    expect(await one().ready()).toBe(1)
    expect(one()).toBe(one())
    expect(builds).toBe(1)
  })
})
