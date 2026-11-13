/**
 * From the re-root the session runs on the two-key account, so Home adds what the backup passkey
 * add has yet to move there: each chunk until the balance read holds it.
 */
import { describe, expect, it } from "vitest"
import {
  balanceToMove,
  type BackupRotationRecord,
  type MoveChunkRecord,
  type MoveRun,
} from "../../src/index.js"
import { PLAN, rotationRecord } from "../__test-helpers__/backupRotation"

// Mixed case, so the address match is shown to ignore case.
const TWO_KEY = "0xAbC0000000000000000000000000000000000022"
const MAIN = "0xMain"
const SHARES = "0xShares"
const ANCHOR = 50
const HASH = `0x${"ab".repeat(32)}` as const

const chunk = (over: Partial<MoveChunkRecord> = {}): MoveChunkRecord => ({
  token: MAIN,
  amount: "100",
  state: "planned",
  ...over,
})
const seen = (blockNumber: number, over: Partial<MoveChunkRecord> = {}) =>
  chunk({ state: "included", txHash: HASH, inclusion: { blockNumber, blockHash: "0xb" }, ...over })
const run = (chunks: MoveChunkRecord[], over: Partial<MoveRun> = {}): MoveRun => ({
  plannedAt: 1,
  m: chunks.length,
  depositBound: false,
  chunks,
  ...over,
})

const record = (over: Partial<BackupRotationRecord> = {}) =>
  rotationRecord({
    phase: "rerooted",
    plan: { ...PLAN, address: TWO_KEY },
    reroot: { switched: true },
    ...over,
  })

const owed = (records: BackupRotationRecord[], token = MAIN) =>
  balanceToMove(records, TWO_KEY, token, ANCHOR)
const owedOne = (chunks: MoveChunkRecord[], over: Partial<BackupRotationRecord> = {}) =>
  owed([record({ move: { runs: [run(chunks)] }, ...over })])

describe("balanceToMove", () => {
  it.each([
    { name: "planned", c: chunk(), counts: true },
    {
      name: "claimed",
      c: chunk({ state: "claimed", claim: { id: "c", session: "s" } }),
      counts: true,
    },
    { name: "submitted", c: chunk({ state: "submitted", txHash: HASH }), counts: true },
    { name: "included above the anchor", c: seen(ANCHOR + 1), counts: true },
    { name: "included at the anchor", c: seen(ANCHOR), counts: false },
    { name: "included and reverted", c: seen(ANCHOR - 1, { effect: "reverted" }), counts: true },
    { name: "mined above the anchor", c: seen(ANCHOR + 1, { state: "mined" }), counts: true },
    { name: "mined below the anchor", c: seen(ANCHOR - 1, { state: "mined" }), counts: false },
    {
      name: "mined with no block saved",
      c: chunk({ state: "mined", txHash: HASH }),
      counts: false,
    },
  ])("counts a chunk $name: $counts", ({ c, counts }) => {
    expect(owedOne([c, seen(1)])).toBe(counts ? 100n : 0n)
  })

  it("counts every chunk with a block while no balance read names one", () => {
    const chunks = [seen(1), chunk({ state: "mined", txHash: HASH, amount: "7" })]
    const moving = record({ move: { runs: [run(chunks)] } })
    expect(balanceToMove([moving], TWO_KEY, MAIN, undefined)).toBe(100n)
  })

  it("sums the latest run's chunks in the token asked for", () => {
    const chunks = [chunk(), chunk({ amount: "40" }), chunk({ token: SHARES, amount: "7" })]
    const earlier = run([chunk({ amount: "999", state: "mined" })], { plannedAt: 0 })
    const moving = record({ move: { runs: [earlier, run(chunks)] } })
    expect(owed([moving])).toBe(140n)
    expect(owed([moving], SHARES)).toBe(7n)
    expect(owed([moving], MAIN.toUpperCase())).toBe(140n)
  })

  it("reads only the record whose two-key account the session runs on", () => {
    const moving = (owner: string, address: string, amount: string) =>
      record({ owner, plan: { ...PLAN, address }, move: { runs: [run([chunk({ amount })])] } })
    const records = [moving("0x02", "0x33", "999"), moving("0x01", TWO_KEY.toLowerCase(), "100")]
    expect(owed(records)).toBe(100n)
    expect(balanceToMove(records, undefined, MAIN, ANCHOR)).toBe(0n)
    expect(balanceToMove(records, TWO_KEY, null, ANCHOR)).toBe(0n)
  })

  it.each([
    { phase: "rerooted", switched: true, counts: true },
    { phase: "moved", switched: true, counts: true },
    { phase: "swept", switched: true, counts: true },
    { phase: "installed", switched: true, counts: true },
    { phase: "swept", switched: false, counts: false },
    { phase: "done", switched: true, counts: false },
  ] as const)("counts at $phase, switched $switched: $counts", ({ phase, switched, counts }) => {
    const reroot = switched ? { switched } : { batch: HASH }
    expect(owedOne([chunk()], { phase, reroot })).toBe(counts ? 100n : 0n)
  })

  it("counts what the one-key account held at the switch until the first run is planned", () => {
    const reroot = {
      switched: true,
      oneKeyBalances: [
        { token: MAIN, amount: "500" },
        { token: SHARES, amount: "9" },
      ],
    }
    expect(owed([record()])).toBe(0n)
    expect(owed([record({ reroot })])).toBe(500n)
    expect(owed([record({ reroot })], SHARES)).toBe(9n)
    // The run's chunks are cut from a later read and replace the switch's.
    expect(owedOne([chunk()], { reroot })).toBe(100n)
  })

  it("keeps counting a run the user declined, and a move paused for their retry", () => {
    expect(owed([record({ move: { runs: [run([chunk()], { declined: true })] } })])).toBe(100n)
    expect(owedOne([chunk()], { phase: "attention", attention: "move", suspended: "moved" })).toBe(
      100n,
    )
  })
})
