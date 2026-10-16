import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"

const h = vi.hoisted(() => ({
  open: vi.fn(),
  nodes: new Map<string, string>(),
}))

vi.mock("@obsidion/sdk", () => ({
  IntraRollupMigrationService: {},
  loadTeeSigner: vi.fn(),
  TokenService: {},
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ sourceRollupNodes: h.nodes }) }))
vi.mock("../src/config/oxideTuple", () => ({ l1PublicClient: vi.fn() }))
vi.mock("../src/platform/sourceRollupWallet", () => ({ openSourceRollupWallet: h.open }))

const { historicChain } = await import("../src/features/migration/historicTokenContext")

const tuple = (portal: string, rollupVersion: string) =>
  ({ portal, rollupVersion } as OxideEnvTuple)
const account = {} as never
const current = tuple("0x" + "01".repeat(20), "7")

beforeEach(() => {
  h.open.mockReset()
  h.nodes.clear()
})

describe("historicChain", () => {
  it("uses the active wallet for a portal on the active rollup", async () => {
    await expect(
      historicChain(account, current, tuple("0x" + "02".repeat(20), "7")),
    ).resolves.toBeUndefined()
    expect(h.open).not.toHaveBeenCalled()
  })

  it("opens the source rollup through the node the profile names for the portal", async () => {
    h.nodes.set("0x" + "ab".repeat(20), "https://old.rpc.example")
    h.open.mockResolvedValue("source")
    await expect(historicChain(account, current, tuple("0x" + "AB".repeat(20), "6"))).resolves.toBe(
      "source",
    )
    expect(h.open).toHaveBeenCalledWith("https://old.rpc.example", account)
  })

  it("refuses a portal on another rollup that no profile version reaches", async () => {
    await expect(
      historicChain(account, current, tuple("0x" + "cd".repeat(20), "6")),
    ).rejects.toThrow(/No node is configured/)
  })
})
