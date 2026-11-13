// @vitest-environment node
// An upgraded device's Savings rows show the figures the base build showed for the same store.
import {
  createMoveStore,
  createWithdrawals,
  loadRecords,
  memoryBackend,
  openDatabase,
} from "@obsidion/front-core"
import type { Address } from "viem"
import { describe, expect, it, vi } from "vitest"
import base from "../../../../front-core/test/fixtures/savingsStore.base.json"
import { savingsMoveFigure } from "../../../src/features/savings/SavingsMoveRow"

const SKY = { id: "fea-sky-v6", factory: base.addresses.factory as Address, fromBlock: 0n }
/** No move of the store lacks its search floor, so none reads L1. */
const noL1 = async (): Promise<bigint> => Promise.reject(new Error("the conversion read L1"))

describe("an upgraded device's Savings rows", () => {
  it("show each converted move's figure on both sides as the base build did", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const db = openDatabase(memoryBackend(new Map(Object.entries(base.databases.current))))
    const withdrawals = createWithdrawals({ db, now: () => base.now })
    const moves = createMoveStore(db, {
      withdrawals: withdrawals.ready,
      sky: async () => SKY,
      blockAt: noL1,
    })
    const records = await loadRecords(moves.view)
    const sharePrice = BigInt(base.base.sharePrice)
    const shown = Object.fromEntries(
      records.map((move) => [
        move.id,
        {
          savings: savingsMoveFigure(move, "savings", sharePrice)?.toString(),
          main: savingsMoveFigure(move, "main", sharePrice)?.toString(),
        },
      ]),
    )
    const was = Object.fromEntries(
      Object.entries(base.base.rows).map(([id, row]) => [id, row.figure]),
    )
    expect(shown).toEqual(was)
  })
})
