// @vitest-environment node
import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  readClaimFpcIdentityCatalog: vi.fn(),
  createOxideL1Reader: vi.fn(),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readClaimFpcIdentityCatalog: h.readClaimFpcIdentityCatalog,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  createOxideL1Reader: h.createOxideL1Reader,
}))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => TUPLE,
  l1PublicClient: () => L1_CLIENT,
}))

import { loadOxideGenerations } from "../src/features/onboarding/oxideGenerations"

const REGISTRY = "0x1111111111111111111111111111111111111111"
const TUPLE = { registry: REGISTRY }
const L1_CLIENT = { kind: "l1-client" }
const READER = { kind: "reader" }
const BINDINGS = [
  {
    fpcAddress: "0x0a",
    accountFactory: "0x3333333333333333333333333333333333333333",
    implementation: "0x4444444444444444444444444444444444444444",
    namePortal: "0x5555555555555555555555555555555555555555",
  },
  {
    fpcAddress: "0x0b",
    accountFactory: "0x6666666666666666666666666666666666666666",
    implementation: "0x7777777777777777777777777777777777777777",
    namePortal: "0x8888888888888888888888888888888888888888",
  },
]

describe("loadOxideGenerations", () => {
  it("stamps the catalog with the wallet's pinned rollup version, never the node's", async () => {
    h.readClaimFpcIdentityCatalog.mockResolvedValue(BINDINGS)
    h.createOxideL1Reader.mockReturnValue(READER)
    const getNodeInfo = vi.fn()
    const wallet = {
      node: { getNodeInfo },
      getNodeIdentity: async () => ({ l1ChainId: 11155111, rollupVersion: 3 }),
    }

    const deps = await loadOxideGenerations(wallet as never, {} as never, {} as never)

    expect(deps.rollupVersion).toBe("3")
    expect(deps.catalog.map((generation) => generation.rollupVersion)).toEqual(["3", "3"])
    expect(deps.catalog.map((generation) => generation.fpcAddress)).toEqual(["0x0a", "0x0b"])
    expect(deps.registry).toBe(REGISTRY)
    expect(deps.reader).toBe(READER)
    expect(h.createOxideL1Reader).toHaveBeenCalledWith(L1_CLIENT)
    expect(getNodeInfo).not.toHaveBeenCalled()
  })
})
