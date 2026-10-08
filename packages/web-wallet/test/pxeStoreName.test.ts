import { afterEach, describe, expect, it, vi } from "vitest"

const { open } = vi.hoisted(() => ({ open: vi.fn(async (..._args: unknown[]) => ({})) }))
vi.mock("@aztec/kv-store/sqlite-opfs", () => ({ AztecSQLiteOPFSStore: { open } }))
vi.mock("@aztec/foundation/log", () => ({ createLogger: () => ({ warn: vi.fn() }) }))

vi.resetModules()
const { createPxeStore, pxeStoreNames } = await import("../src/platform/storage/createPxeStore")

const ROLLUP = "0x" + "a".repeat(40)
const DIGEST = "0123456789abcdef0123456789abcdef"

afterEach(() => open.mockClear())

/** The default node keeps the names existing stores were created under; a custom node gets its own. */
describe("pxeStoreNames", () => {
  it("names the default node's store as it always has", () => {
    expect(pxeStoreNames(ROLLUP, undefined)).toEqual({
      dbName: `pxe_data_${ROLLUP}`,
      directory: `.aztec-kv-pxe-${ROLLUP}`,
    })
  })

  it("suffixes both names with the endpoint digest for a custom node", () => {
    expect(pxeStoreNames(ROLLUP, DIGEST)).toEqual({
      dbName: `pxe_data_${ROLLUP}_${DIGEST}`,
      directory: `.aztec-kv-pxe-${ROLLUP}_${DIGEST}`,
    })
  })

  it("opens the OPFS pool under the digest-suffixed names", async () => {
    Object.defineProperty(navigator, "storage", {
      value: { getDirectory: async () => ({}) },
      configurable: true,
    })
    Object.defineProperty(navigator, "locks", { value: { request: vi.fn() }, configurable: true })
    await createPxeStore(ROLLUP, DIGEST)
    expect(open.mock.calls[0]!.slice(1)).toEqual([
      `pxe_data_${ROLLUP}_${DIGEST}`,
      false,
      `.aztec-kv-pxe-${ROLLUP}_${DIGEST}`,
    ])
  })
})
