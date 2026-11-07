// @vitest-environment node
/** The SIPA passes run one at a time: a task's pass and a previous account's never overlap. */
import { describe, expect, it } from "vitest"
import { passQueue } from "../../../../src/features/deposit/sipaTasks"

const deferred = () => {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("passQueue", () => {
  it("starts a pass once the one before it ended, though that one failed", async () => {
    const queue = passQueue()
    const first = deferred()
    const started: string[] = []
    const a = queue("a", undefined, () => {
      started.push("a")
      return first.promise
    })
    const b = queue("b", undefined, async () => {
      started.push("b")
      return "b"
    })
    await Promise.resolve()
    expect(started).toEqual(["a"])

    const down = new Error("rpc down")
    first.reject(down)
    await expect(a).rejects.toBe(down)
    await expect(b).resolves.toBe("b")
    expect(started).toEqual(["a", "b"])
  })

  it("never starts a pass aborted while it waited; the next one still runs", async () => {
    const queue = passQueue()
    const first = deferred()
    const stop = new AbortController()
    const started: string[] = []
    void queue("a", undefined, () => first.promise)
    const aborted = queue("b", stop.signal, async () => void started.push("b"))
    const next = queue("c", undefined, async () => void started.push("c"))

    stop.abort()
    first.resolve()

    await expect(aborted).rejects.toMatchObject({ code: "aborted" })
    await next
    expect(started).toEqual(["c"])
  })
})
