import { describe, expect, it } from "vitest"
import { showErrorModal, subscribeErrorModal } from "../src/errors/errorModal"

describe("errorModal emitter", () => {
  it("buffers pre-mount errors (capped at 3) and flushes on subscribe", () => {
    for (let i = 0; i < 5; i++) showErrorModal({ title: `t${i}`, message: "m" })
    const seen: string[] = []
    const unsub = subscribeErrorModal((p) => seen.push(p.title))
    expect(seen).toEqual(["t0", "t1", "t2"])

    showErrorModal({ title: "live", message: "m" })
    expect(seen).toEqual(["t0", "t1", "t2", "live"])

    unsub()
    showErrorModal({ title: "after", message: "m" })
    expect(seen).toHaveLength(4)
  })
})
