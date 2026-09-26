import { afterEach, describe, expect, it, vi } from "vitest"

const { open } = vi.hoisted(() => ({ open: vi.fn(async (..._args: unknown[]) => ({})) }))
vi.mock("@aztec/kv-store/sqlite-opfs", () => ({ AztecSQLiteOPFSStore: { open } }))
vi.mock("@aztec/foundation/log", () => ({ createLogger: () => ({ warn: vi.fn() }) }))

import { createPxeStore } from "../src/platform/storage/createPxeStore"

function stubStorage(getDirectory: () => Promise<unknown>) {
  Object.defineProperty(navigator, "storage", { value: { getDirectory }, configurable: true })
  Object.defineProperty(navigator, "locks", { value: { request: vi.fn() }, configurable: true })
}

afterEach(() => open.mockClear())

describe("createPxeStore", () => {
  it("opens the rollup-scoped OPFS pool when getDirectory resolves", async () => {
    stubStorage(async () => ({}))
    await createPxeStore("0xabc")
    expect(open.mock.calls[0].slice(1)).toEqual(["pxe_data_0xabc", false, ".aztec-kv-pxe-0xabc"])
  })

  it("falls back to an in-memory DB when getDirectory rejects (Safari private mode)", async () => {
    stubStorage(() => Promise.reject(new DOMException("unknown transient reason", "UnknownError")))
    await createPxeStore("0xabc")
    expect(open.mock.calls[0].slice(1)).toEqual([undefined, true])
  })
})
