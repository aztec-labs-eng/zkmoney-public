/**
 * sourceFrozenEscrows — which of this browser's link rows become discovery hints for a frozen source:
 * the rows the residual probe attributes to it, in this rollup's database and earlier ones, and only
 * links on the source's chain and rollup, read for one account.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { SessionChangedError } from "../src/platform/auth/sessionErrors"

const h = vi.hoisted(() => ({
  discover: vi.fn(),
  rows: [] as unknown[],
  otherRows: [] as unknown[],
  storageId: "acct-a" as string | null,
  onOtherRead: () => {},
  onDecode: () => {},
  reads: 0,
  decodes: 0,
}))

vi.mock("@obsidion/sdk", () => ({
  ContractService: { getInstance: () => ({}) },
  createTransferEventSource: () => ({}),
  discoverFrozenEscrows: h.discover,
  PaylinkService: class {},
  TokenService: { create: async () => ({}) },
}))
vi.mock("@obsidion/front-core", () => ({
  TRANSACTIONS_STORAGE_KEY: "obsidion_transactions",
  TransactionStorage: {
    get: () => ({
      getTransactions: async () => {
        h.reads++
        return h.rows
      },
    }),
  },
  creatorLinksFromRows: async (rows: Array<{ link: unknown }>) => {
    h.decodes++
    h.onDecode()
    return rows.map((row) => row.link)
  },
}))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({
  webStorage: {
    getItemFromOtherDatabases: async () => {
      h.onOtherRead()
      return [JSON.stringify(h.otherRows)]
    },
  },
}))
vi.mock("../src/platform/storage/activeStorage", () => ({ getActiveStorageId: () => h.storageId }))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ l1ChainId: 31337 }) }))

const { sourceFrozenEscrows } = await import("../src/features/migration/sourceFrozenEscrows")

const SOURCE_TOKEN = "0x" + "01".repeat(32)
const tuple = { l2Token: SOURCE_TOKEN, rollupVersion: "7" } as OxideEnvTuple
const current = { timestamp: "2026-08-14T10:00:00.000Z" } as OxideEnvTuple
const before = Date.parse("2026-08-01T00:00:00Z")
const link = (name: string, rollupVersion = 7, chainId = 31337) => ({
  name,
  rollupVersion,
  chainId,
})
const row = (name: string, over: Record<string, unknown> = {}) => ({
  emailPaymentAction: "Pay To Email",
  timestamp: before,
  link: link(name),
  ...over,
})
const discover = () =>
  sourceFrozenEscrows({
    chain: { wallet: {} as never, account: { getAddress: () => "0xacc" } as never },
    tuple,
    current,
    masterSecret: {} as never,
    storageId: "acct-a",
  })

describe("sourceFrozenEscrows", () => {
  beforeEach(() => {
    h.discover.mockReset()
    h.discover.mockResolvedValue([])
    h.storageId = "acct-a"
    h.onOtherRead = () => {}
    h.onDecode = () => {}
    h.otherRows = []
    h.reads = 0
    h.decodes = 0
  })

  it("hints the source's links, legacy rows included, from every database", async () => {
    h.rows = [
      row("tokened", { tokenAddress: SOURCE_TOKEN.toUpperCase().replace("0X", "0x") }),
      row("legacy"),
      row("after the cutover", { timestamp: Date.parse("2026-08-15T00:00:00Z") }),
      row("another token", { tokenAddress: "0x" + "02".repeat(32) }),
      row("another rollup", { link: link("another rollup", 9) }),
      row("another chain", { link: link("another chain", 7, 1) }),
    ]
    h.otherRows = [row("earlier rollup", { tokenAddress: SOURCE_TOKEN })]
    await discover()
    expect(h.discover.mock.calls[0]![0].hints.map((l: { name: string }) => l.name)).toEqual([
      "tokened",
      "legacy",
      "earlier rollup",
    ])
  })

  it("fails when the account changes during the read", async () => {
    h.rows = [row("legacy")]
    h.onOtherRead = () => {
      h.storageId = "acct-b"
    }
    await expect(discover()).rejects.toBeInstanceOf(SessionChangedError)
    expect(h.decodes).toBe(0)
    expect(h.discover).not.toHaveBeenCalled()
  })

  it("fails when the account changes while the links decode", async () => {
    h.rows = [row("legacy")]
    h.onDecode = () => {
      h.storageId = "acct-b"
    }
    await expect(discover()).rejects.toBeInstanceOf(SessionChangedError)
    expect(h.discover).not.toHaveBeenCalled()
  })

  it("reads nothing for another account", async () => {
    h.storageId = "acct-b"
    await expect(discover()).rejects.toBeInstanceOf(SessionChangedError)
    expect(h.reads).toBe(0)
    expect(h.discover).not.toHaveBeenCalled()
  })
})
