// The cases every `KvStore` passes: the in-memory fakes here, walletStorage in web-wallet and the
// bot's file store in xmtp-bot. Only `vitest` and engine sources are imported, so other packages
// run it.
import { describe, expect, it } from "vitest"
import type { KvStore } from "../../src/engine/kv"
import * as srcStores from "../../src/engine/store"

export function kvContract(
  name: string,
  open: () => KvStore | Promise<KvStore>,
  opts: {
    /** A fresh store over what the last one saved, once its writes settle. */
    reopen?: () => KvStore | Promise<KvStore>
    /** While on, every save fails. */
    failing?: (on: boolean) => void
    /** The store module the implementation batches with, when it is not this source tree's. */
    stores?: Pick<typeof srcStores, "memoryStore" | "derived">
  } = {},
): void {
  const { reopen, failing, stores: { memoryStore, derived } = srcStores } = opts
  describe(`KvStore contract: ${name}`, () => {
    it("reads its own writes at once", async () => {
      const kv = await open()
      kv.setItem("a", "1")
      expect(kv.getItem("a")).toBe("1")
      kv.removeItem("a")
      expect(kv.getItem("a")).toBeNull()
    })

    it("lists the keys it holds", async () => {
      const kv = await open()
      await kv.commitTransaction([
        ["x/1", "1"],
        ["x/2", "2"],
      ])
      kv.removeItem("x/1")
      expect(kv.keys().filter((key) => key.startsWith("x/"))).toEqual(["x/2"])
    })

    it("applies a transaction's writes and removals together", async () => {
      const kv = await open()
      kv.setItem("gone", "1")
      await kv.commitTransaction([
        ["kept", "2"],
        ["gone", null],
      ])
      expect(kv.getItem("kept")).toBe("2")
      expect(kv.getItem("gone")).toBeNull()
    })

    it("sees a batch's writes inside and after it", async () => {
      const kv = await open()
      let inside: string | null = null
      const saved = kv.batch(() => {
        kv.setItem("b", "1")
        inside = kv.getItem("b")
      })
      expect(inside).toBe("1")
      await saved
      expect(kv.getItem("b")).toBe("1")
    })

    it("keeps nothing a throwing batch wrote", async () => {
      const kv = await open()
      expect(() =>
        kv.batch(() => {
          kv.setItem("c", "1")
          throw new Error("boom")
        }),
      ).toThrow("boom")
      expect(kv.getItem("c")).toBeNull()
    })

    it("tells listeners each saved write, a batch's in one call, and nothing of a throwing batch", async () => {
      const kv = await open()
      const heard: (readonly (readonly [string, string | null])[])[] = []
      const off = kv.onCommit((ops) => heard.push(ops.filter(([key]) => key.startsWith("n/"))))
      kv.setItem("n/a", "1")
      await kv.commitTransaction([
        ["n/b", "2"],
        ["n/a", null],
      ])
      await kv.batch(() => {
        kv.setItem("n/c", "3")
        kv.setItem("n/d", "4")
      })
      expect(() =>
        kv.batch(() => {
          kv.setItem("n/e", "5")
          throw new Error("boom")
        }),
      ).toThrow("boom")
      off()
      kv.setItem("n/f", "6")
      await kv.commitTransaction([])
      expect(heard.filter((ops) => ops.length > 0)).toEqual([
        [["n/a", "1"]],
        [
          ["n/b", "2"],
          ["n/a", null],
        ],
        [
          ["n/c", "3"],
          ["n/d", "4"],
        ],
      ])
    })

    it("runs a transaction's listeners in one store batch", async () => {
      const kv = await open()
      const a = memoryStore(0)
      const b = memoryStore(0)
      const offs = [kv.onCommit(() => a.set(1)), kv.onCommit(() => b.set(1))]
      const both = derived([a, b] as const, (x, y) => [x, y])
      const seen: number[][] = []
      both.subscribe(() => seen.push(both.get()))
      await kv.commitTransaction([["t", "1"]])
      offs.forEach((off) => off())
      expect(seen).toEqual([[1, 1]])
    })

    if (failing) {
      it("drops a failed write from reads, throws only from a batch or transaction, and tells no listener", async () => {
        const kv = await open()
        await kv.commitTransaction([["f", "1"]])
        const heard: string[] = []
        const off = kv.onCommit((ops) =>
          ops.forEach(([key]) => key.startsWith("f") && heard.push(key)),
        )
        failing(true)
        // A background write never throws; a batch or transaction rejects.
        expect(() => kv.setItem("f", "2")).not.toThrow()
        const batched = kv.batch(() => kv.setItem("f2", "2"))
        await expect(batched).rejects.toThrow()
        await expect(kv.commitTransaction([["f3", "3"]])).rejects.toThrow()
        failing(false)
        await kv.commitTransaction([])
        off()
        expect([kv.getItem("f"), kv.getItem("f2"), kv.getItem("f3")]).toEqual(["1", null, null])
        expect(heard).toEqual([])
      })
    }

    if (reopen) {
      it("keeps saved writes across a reopen", async () => {
        const kv = await open()
        kv.setItem("p", "1")
        await kv.commitTransaction([["q", "2"]])
        const again = await reopen()
        expect(again.getItem("p")).toBe("1")
        expect(again.getItem("q")).toBe("2")
      })
    }
  })
}
