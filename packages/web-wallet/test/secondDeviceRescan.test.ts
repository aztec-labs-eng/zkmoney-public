/**
 * A second device: empty move and withdrawal stores, the rescan over both tokens rebuilds a move
 * into Savings and a move back to Main, and the settle pass adopts and claims both on this PXE.
 * The balance itself is PXE state the claim writes; what is checked here is that the claim runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { getAddress, type Address, type Hex } from "viem"
import type { ScannedWithdrawEvent } from "@obsidion/sdk"
import { SavingsMoveStorage, settleSavingsMoves } from "@obsidion/front-core"
import { walletStorage } from "../src/platform/storage/walletStorage"
import { InMemoryStorageAdapter } from "./support/memoryStorage"

const MAIN_TOKEN = `0x${"1a".repeat(32)}`
const SAVINGS_TOKEN = `0x${"2b".repeat(32)}`
const MAIN_PORTAL = getAddress(`0x${"70".repeat(20)}`)
const SAVINGS_PORTAL = getAddress(`0x${"71".repeat(20)}`)
const FACTORY = getAddress(`0x${"f1".repeat(20)}`)
const ESCROW_IN = getAddress(`0x${"e1".repeat(20)}`)
const ESCROW_OUT = getAddress(`0x${"e2".repeat(20)}`)
const NONCE_IN = `0x${"03".repeat(32)}` as Hex
const NONCE_OUT = `0x${"04".repeat(32)}` as Hex
/** `SkyRoute` of the burn's meta: Stake (0) into Savings, Unstake (1) back to Main. */
const STAKE = 0
const UNSTAKE = 1

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
  l1Transport: () => ({}),
}))
// Main's tuple carries only its portal: no withdrawal wiring, so no chain watcher is armed.
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ portal: MAIN_PORTAL }),
  l1PublicClient: () => ({ readContract: async () => 0n }),
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: async () => undefined }),
}))

const sky = (route: number, nonce: Hex) => ({
  route,
  factory: FACTORY,
  recipientCommitment: `0x${"2c".repeat(32)}` as Hex,
  recoveryCommitment: `0x${"2d".repeat(32)}` as Hex,
  relayerTip: 10n ** 18n,
  nonce,
})
/** What each token's `Withdraw` events say: one move in from Main's token, one move out from Savings'. */
const EVENTS: Record<string, ScannedWithdrawEvent[]> = {
  [MAIN_TOKEN]: [
    {
      txHash: `0x${"aa".repeat(32)}`,
      blockNumber: 40,
      l1Recipient: ESCROW_IN,
      amount: 25n * 10n ** 18n,
      sky: sky(STAKE, NONCE_IN) as never,
    },
  ],
  [SAVINGS_TOKEN]: [
    {
      txHash: `0x${"bb".repeat(32)}`,
      blockNumber: 60,
      l1Recipient: ESCROW_OUT,
      amount: 7n * 10n ** 18n,
      sky: sky(UNSTAKE, NONCE_OUT) as never,
    },
  ],
}
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  createWithdrawEventSource: vi.fn(({ tokenAddress }: { tokenAddress: string }) => ({
    headBlock: async () => 100,
    listWithdrawals: async () => EVENTS[tokenAddress] ?? [],
    // Burns from about a thousand L1 blocks before the head below.
    blockTimestampMs: async () => L1_TIME(49_000n) * 1000,
  })),
}))

const { getWithdrawalStore, rescanWithdrawals } = await import(
  "../src/features/withdraw/withdrawGateway"
)

const token = (address: string, symbol: string) => ({
  fetchTokenInformation: async () => ({ address, symbol, name: symbol, decimals: 18 }),
})
const SAVINGS_TUPLE = { portal: SAVINGS_PORTAL, l2Token: SAVINGS_TOKEN } as never
/** L1 block times: twelve seconds a block. */
const L1_TIME = (block: bigint) => 1_000_000 + Number(block) * 12

describe("a second device", () => {
  beforeEach(async () => {
    walletStorage.setItem(
      "webwallet.identity",
      JSON.stringify({ address: `0x${"0".repeat(63)}5`, claimedAt: 0 }),
    )
    await getWithdrawalStore().clearAll()
  })

  it("rebuilds both directions from both tokens, with each burn's deployment, and claims them on its own PXE", async () => {
    const wallet = { node: { getBlockNumber: async () => 100n } } as never
    const rebuilt = await rescanWithdrawals(wallet, [
      { tokenService: token(MAIN_TOKEN, "DAI") },
      { tokenService: token(SAVINGS_TOKEN, "sUSDS"), tuple: SAVINGS_TUPLE },
    ])
    expect(rebuilt.map((r) => [r.skyMove?.direction, r.tokenSymbol, r.deployment])).toEqual([
      ["in", "DAI", undefined],
      ["out", "sUSDS", { portal: SAVINGS_PORTAL, l2Token: SAVINGS_TOKEN }],
    ])
    expect(rebuilt.every((r) => r.rebuilt && r.phase === "l2_mined")).toBe(true)

    // The settle pass: the move store is empty, so both burns are adopted; each destination portal
    // holds the deposit, found from the burn's own time; Main's token already spent its deposit
    // on the first device, which counts as claimed.
    const moves = new SavingsMoveStorage(new InMemoryStorageAdapter())
    const claims = { main: vi.fn(), savings: vi.fn() }
    const publicClient = {
      getBlockNumber: async () => 50_000n,
      getBlock: async (arg: { blockTag?: string; blockNumber?: bigint }) =>
        arg.blockNumber !== undefined
          ? { number: arg.blockNumber, timestamp: BigInt(L1_TIME(arg.blockNumber)) }
          : { number: 49_990n },
      getContractEvents: vi.fn(async ({ address }: { address: Address }) => [
        { args: { index: address === SAVINGS_PORTAL ? 11n : 22n, amount: 5n } },
      ]),
    }
    await settleSavingsMoves(
      moves,
      {
        publicClient: publicClient as never,
        masterSecret: new Fr(7n),
        recipient: AztecAddress.fromStringUnsafe(`0x${"0".repeat(63)}5`),
        main: {
          portal: MAIN_PORTAL,
          claimer: async () => ({
            claimSweptDeposit: async (params: unknown) => {
              claims.main(params)
              throw new Error("Assertion failed: deposit already spent")
            },
          }),
        },
        savings: {
          portal: SAVINGS_PORTAL,
          claimer: async () => ({
            claimSweptDeposit: async (params: unknown) => claims.savings(params),
          }),
        },
      } as never,
      getWithdrawalStore().list(),
    )
    const byDirection = Object.fromEntries(moves.list().map((m) => [m.direction, m]))
    expect(byDirection.in.deposit).toEqual({ inboxIndex: "11", amount: "5", claimed: true })
    expect(byDirection.out.deposit).toEqual({ inboxIndex: "22", amount: "5", claimed: true })
    expect(claims.savings).toHaveBeenCalledWith(expect.objectContaining({ inboxIndex: 11n }))
    expect(claims.main).toHaveBeenCalledWith(expect.objectContaining({ inboxIndex: 22n }))
    // Each search started from the burn's block time, not the chain's start.
    const froms = publicClient.getContractEvents.mock.calls.map(
      (c) => (c[0] as unknown as { fromBlock: bigint }).fromBlock,
    )
    expect(froms).toHaveLength(2)
    expect(froms.every((from) => from > 40_000n && from <= 49_000n)).toBe(true)
  })
})
