// @vitest-environment node
import type { SpendShape } from "@obsidion/sdk"
import { describe, expect, it, vi } from "vitest"
import { fakeReads } from "../../support/fakeReads"
import { holdingsOf } from "../../support/holdings"

const DAI = 10n ** 18n
const MAIN = { l2Token: "0xmain", portal: "0xmainportal" }
const SAVINGS = { l2Token: "0xsavings", portal: "0xsavingsportal" }
const caps: Record<string, bigint> = { "0xmainportal": 2n * DAI, "0xsavingsportal": 7n * DAI }
const h = vi.hoisted(() => ({
  holdings: undefined as unknown,
  shapes: {} as Record<string, unknown>,
}))

vi.mock("../../../src/config/classArtifacts", () => ({
  getWebOxideToken: async (_wallet: unknown, _contracts: unknown, token: string) => ({ token }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readSpendShape: async (_wallet: unknown, { token }: { token: string }) => h.shapes[token],
}))

const { backupMoveTokens, moveCap, moveCount, readMoveBalances } = await import(
  "../../../src/features/backupPasskey/backupMoveTokens"
)

const reads = fakeReads({
  feeTokenBridgeTuple: async () => MAIN,
  holdings: () => h.holdings,
  bridgeOfToken: async (token: string) => {
    const bridge = [MAIN, SAVINGS].find((b) => b.l2Token === token.toLowerCase())
    if (!bridge) throw new Error(`No oxide bridge lists the token ${token}`)
    return bridge
  },
  txAmountCap: async (portal: string) => caps[portal],
}) as never

/** A balance held in `notes`, none of it in deposits. */
const shape = (...notes: bigint[]): SpendShape => ({
  balance: notes.reduce((a, b) => a + b, 0n),
  notes,
  depositTotal: 0n,
})

describe("backupMoveTokens", () => {
  it("moves Main Account's token alone where the deployment has no Savings", async () => {
    h.holdings = Promise.resolve(holdingsOf())
    expect(await backupMoveTokens(reads)).toEqual(["0xmain"])
  })
})

describe("moveCap", () => {
  it("is each token's own portal's cap, looked up when asked", async () => {
    expect(await moveCap(reads, "0xmain")).toBe(2n * DAI)
    expect(await moveCap(reads, "0xSAVINGS")).toBe(7n * DAI)
  })
})

describe("readMoveBalances and moveCount", () => {
  it("reads every moved balance under its own cap, and counts the sends they take", async () => {
    h.holdings = Promise.resolve(holdingsOf(SAVINGS))
    h.shapes = { "0xmain": shape(3n * DAI), "0xsavings": shape(10n * DAI) }
    const balances = await readMoveBalances(reads, {} as never, {} as never, {} as never)
    expect(balances).toEqual([
      { token: "0xmain", shape: shape(3n * DAI), cap: 2n * DAI },
      { token: "0xsavings", shape: shape(10n * DAI), cap: 7n * DAI },
    ])
    // Two sends of Main's 3 under a cap of 2, and two of Savings' 10 under a cap of 7.
    expect(moveCount(balances)).toBe(4)
    expect(moveCount(balances.slice(0, 1))).toBe(2)
  })
})
