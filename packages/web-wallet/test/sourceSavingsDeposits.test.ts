import { beforeEach, describe, expect, it, vi } from "vitest"
const h = vi.hoisted(() => ({ scan: vi.fn(), source: vi.fn(), domain: vi.fn(), executor: vi.fn() }))
vi.mock("@obsidion/front-core", () => ({
  deploymentScanRange: async () => ({ fromBlock: 112n, toBlock: 2000n }),
  refundableSavingsDeposits: h.scan,
  savingsRoute: () => 0,
}))
vi.mock("@obsidion/sdk", () => ({
  createWithdrawEventSource: h.source,
  readWithdrawalExecutor: h.executor,
}))
vi.mock("../src/features/token/oxideToken", () => ({
  portalContract: () => ({ getPortalDomain: h.domain }),
}))
const { sourceSavingsDeposits } = await import("../src/features/migration/sourceSavingsDeposits")
const target = {
  portal: "sky-v5",
  rollupVersion: "5",
  plainWithdrawalExecutor: "executor",
} as never
const main = { portal: "dai-v5", rollupVersion: "5", plainWithdrawalExecutor: "executor" } as never
const other = { portal: "dai-v6", rollupVersion: "6" } as never
const move = {
  direction: "in",
  factory: "factory",
  nonce: "nonce",
  recipientCommitment: "commitment",
}
const descriptor = { messageKey: "deposit", amount: "40000000000000000000" }
const onUnverified = () => {}
const input = (chain: unknown) => ({
  chain: chain as never,
  tuple: target,
  sourceTuples: [main, target, other],
  publicClient: {} as never,
  masterSecret: {} as never,
  scanHead: 2000n,
  onUnverified,
})
beforeEach(() => {
  vi.clearAllMocks()
  h.scan.mockResolvedValue([descriptor])
})
describe("source Savings deposit recovery", () => {
  it("reads every source token's withdrawals through its generation without saved move records", async () => {
    const savingsMoves = vi.fn(async ({ tuple }) => (tuple === main ? [move] : []))
    await expect(
      sourceSavingsDeposits(
        input({ kind: "generation", session: { address: "v5-account", savingsMoves } }),
      ),
    ).resolves.toEqual([descriptor])
    expect(savingsMoves.mock.calls.map(([o]) => o.tuple)).toEqual([main, target])
    expect(h.scan).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: "v5-account",
        moves: [move],
        portal: "sky-v5",
        fromBlock: 112n,
        head: 2000n,
        onUnverified,
      }),
    )
  })
  it("reads the current generation's verified withdrawal memos through its SDK", async () => {
    const list = vi.fn(async () => [{ sky: { ...move, route: 0 } }, {}])
    h.source.mockReturnValue({ headBlock: async () => 913, listWithdrawals: list })
    await sourceSavingsDeposits(
      input({ kind: "pxe", wallet: {}, account: { getAddress: () => "account" } }),
    )
    await h.source.mock.calls[0][0].readExecutor("plain-executor")
    expect(h.executor).toHaveBeenCalledWith({}, "plain-executor", "plain")
    expect(list).toHaveBeenCalledWith(1, 914)
    expect(h.scan.mock.calls[0][0].moves).toEqual([move, move])
  })
  it("reads the Sky executor model for burns through a source feature's converting executor", async () => {
    h.source.mockReturnValue({ headBlock: async () => 913, listWithdrawals: async () => [] })
    const args = input({ kind: "pxe", wallet: {}, account: { getAddress: () => "account" } })
    args.sourceTuples = [
      {
        ...(main as object),
        features: [{ project: "sky", contracts: { skyWithdrawalExecutor: "sky-executor" } }],
      },
    ] as never
    await sourceSavingsDeposits(args)
    await h.source.mock.calls[0][0].readExecutor("sky-executor")
    expect(h.executor).toHaveBeenCalledWith({}, "sky-executor", "sky")
  })
  it("propagates source-event failures instead of reporting an empty deposit list", async () => {
    const savingsMoves = vi.fn(async () => {
      throw new Error("source unavailable")
    })
    await expect(
      sourceSavingsDeposits(
        input({ kind: "generation", session: { address: "account", savingsMoves } }),
      ),
    ).rejects.toThrow("source unavailable")
    expect(h.scan).not.toHaveBeenCalled()
  })
})
