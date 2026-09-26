import { describe, expect, it } from "vitest"
import { durationShards } from "./durationShards.js"

describe("durationShards", () => {
  it("puts every file in exactly one shard", () => {
    const files = ["a", "b", "c", "d", "e"]
    const shards = durationShards(files, { a: 5, b: 4 }, 3)
    expect(shards.flat().sort()).toEqual(files)
  })

  it("balances by seconds, not file count", () => {
    const shards = durationShards(["long", "x", "y", "z"], { long: 30, x: 10, y: 10, z: 10 }, 2)
    expect(shards).toEqual([["long"], ["x", "y", "z"]])
  })

  it("is deterministic across input order", () => {
    const seconds = { a: 3, b: 3, c: 1 }
    expect(durationShards(["c", "b", "a"], seconds, 2)).toEqual(
      durationShards(["a", "b", "c"], seconds, 2),
    )
  })
})
