import { describe, expect, it } from "vitest"
import { createMemoryKv, prefixedKv } from "../../src/engine/kv"
import { diskKv } from "./diskKv"
import { kvContract } from "./kvContract"

kvContract("memory", () => createMemoryKv())
kvContract("prefixed", () => prefixedKv(createMemoryKv(), "ns."))
let disk = diskKv()
kvContract("disk double", () => (disk = diskKv()).kv, { failing: (on) => disk.fail(on) })
kvContract("prefixed disk", () => prefixedKv((disk = diskKv()).kv, "ns."), {
  failing: (on) => disk.fail(on),
})

describe("prefixedKv", () => {
  it("reads and writes only under its prefix", async () => {
    const entries = new Map([["other", "x"]])
    const kv = prefixedKv(createMemoryKv(entries), "ns.")
    kv.setItem("a", "1")
    await kv.commitTransaction([["b", "2"]])
    expect([...entries.keys()].sort()).toEqual(["ns.a", "ns.b", "other"])
    expect(kv.keys().sort()).toEqual(["a", "b"])
    expect(kv.getItem("other")).toBeNull()
  })

  it("lets go of its listeners once its signal aborts", async () => {
    const root = createMemoryKv()
    const scope = new AbortController()
    const kv = prefixedKv(root, "ns.", scope.signal)
    const heard: string[] = []
    kv.onCommit((ops) => ops.forEach(([key]) => heard.push(key)))
    root.setItem("ns.a", "1")
    scope.abort()
    root.setItem("ns.b", "1")
    expect(heard).toEqual(["a"])
  })
})
