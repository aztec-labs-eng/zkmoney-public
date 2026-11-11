import { describe, expect, it } from "vitest"
import { createKeyedTurn, createTurn } from "../../src/engine/turns"

function deferred() {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const died = new Error("run died")
const tick = () => new Promise((r) => setTimeout(r, 0))

describe("a turn", () => {
  it("starts each run once the one before it settled, failed or not", async () => {
    const turn = createTurn()
    const first = deferred()
    const started: string[] = []
    const a = turn(async () => {
      started.push("a")
      await first.promise
    })
    const b = turn(async () => void started.push("b"))
    await tick()
    expect(started).toEqual(["a"])
    first.reject(died)
    await expect(a).rejects.toBe(died)
    await b
    expect(started).toEqual(["a", "b"])
  })
})

describe("a keyed turn", () => {
  it("queues runs of one key and lets another key run alongside", async () => {
    const turn = createKeyedTurn()
    const first = deferred()
    const started: string[] = []
    const a = turn("0xA", async () => {
      started.push("a1")
      await first.promise
    })
    const a2 = turn("0xA", async () => void started.push("a2"))
    const b = turn("0xB", async () => void started.push("b"))
    await b
    expect(started).toEqual(["a1", "b"])
    first.resolve()
    await Promise.all([a, a2])
    expect(started).toEqual(["a1", "b", "a2"])
  })
})
