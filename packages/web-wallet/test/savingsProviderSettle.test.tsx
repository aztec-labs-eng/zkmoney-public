/**
 * The Savings provider settles as soon as a rescan rebuilds a burn with Sky meta the move store
 * does not know, not on the next tick: a second device adopts and claims its moves right away. At
 * its boot stage it replays the moves: both tokens' burns rebuilt, then one pass, then boot is told.
 */
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SavingsMoveStorage, WithdrawalStorage, type WithdrawalRecord } from "@obsidion/front-core"
import { InMemoryStorageAdapter } from "./support/memoryStorage"

const h = vi.hoisted(() => ({
  settle: vi.fn(async () => {}),
  tuple: vi.fn(async (): Promise<unknown> => ({ portal: `0x${"71".repeat(20)}`, l2Token: "0x2b" })),
  rescan: vi.fn(async (_wallet: unknown, _tokens: unknown[]): Promise<unknown[]> => []),
  savingsToken: vi.fn(async (): Promise<unknown> => ({ label: "sUSDS" })),
  // The replay's stage; most tests never reach it.
  whenReady: vi.fn((_reader: string) => new Promise<void>(() => {})),
  movesReplayed: vi.fn(),
}))
const moves = new SavingsMoveStorage(new InMemoryStorageAdapter())
const withdrawals = WithdrawalStorage.get(new InMemoryStorageAdapter())

// Stable like the real contexts: the source is memoized over them.
const ctx = vi.hoisted(() => ({
  aztec: { obsidionWallet: {}, currentNetwork: { type: "sandbox" } },
  account: { obsidionAccount: {} },
  asset: { tokenService: {} },
  contracts: { contractService: {} },
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ctx.aztec,
  useAccountContext: () => ctx.account,
  useAssetContext: () => ctx.asset,
  useContractServiceContext: () => ctx.contracts,
  useBootReady: () => true,
  bootPriority: { whenReady: h.whenReady, movesReplayed: h.movesReplayed },
  SavingsProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../src/features/savings/savingsGateway", () => ({
  getSavingsTuple: () => h.tuple(),
  createSavingsSource: () => ({ moves, settle: h.settle }),
  savingsRescanToken: () => h.savingsToken(),
}))
vi.mock("../src/features/savings/savingsMoveStore", () => ({ getSavingsMoveStore: () => moves }))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  getWithdrawalStore: () => withdrawals,
  rescanWithdrawals: h.rescan,
}))

const { WebSavingsProvider } = await import("../src/features/savings/SavingsProvider")

const burn = (localId: string, sky: boolean): WithdrawalRecord =>
  ({
    localId,
    recipient: `0x${"e1".repeat(20)}`,
    recipientProvenance: "saved-recipient",
    amount: "25",
    rawAmount: (25n * 10n ** 18n).toString(),
    tokenSymbol: "DAI",
    phase: "l2_mined",
    startTime: 1_000,
    rebuilt: true,
    ...(sky
      ? {
          skyMove: {
            direction: "in",
            factory: `0x${"f1".repeat(20)}`,
            recipientCommitment: `0x${"2c".repeat(32)}`,
            recoveryCommitment: `0x${"2d".repeat(32)}`,
            relayerTip: "1",
            nonce: `0x${"03".repeat(32)}`,
          },
        }
      : {}),
  } as WithdrawalRecord)

let host: HTMLDivElement
let root: Root
beforeEach(async () => {
  vi.clearAllMocks()
  h.whenReady.mockImplementation(() => new Promise<void>(() => {}))
  h.rescan.mockImplementation(async () => [])
  await moves.load()
  await withdrawals.load()
  await withdrawals.clearAll()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe("WebSavingsProvider", () => {
  it("replays the moves at its boot stage: both tokens rescanned, then a pass, then boot told", async () => {
    let stage!: () => void
    h.whenReady.mockImplementation(() => new Promise<void>((resolve) => (stage = resolve)))
    let rebuilt!: () => void
    h.rescan.mockImplementation(
      (_wallet, tokens) =>
        new Promise((resolve) => {
          if ((tokens[0] as { label?: string }).label === "sUSDS") rebuilt = () => resolve([])
          else resolve([])
        }),
    )
    await act(async () => root.render(<WebSavingsProvider>{null}</WebSavingsProvider>))
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledTimes(1))
    expect(h.whenReady).toHaveBeenCalledWith("savingsMoves")
    expect(h.rescan).not.toHaveBeenCalled()

    await act(async () => stage())
    await vi.waitFor(() => expect(h.rescan).toHaveBeenCalledTimes(2))
    expect(h.rescan.mock.calls.map(([, tokens]) => tokens)).toEqual([
      [{ tokenService: ctx.asset.tokenService }],
      [{ label: "sUSDS" }],
    ])
    // The pass waits for the move out's burn to be rebuilt.
    expect(h.settle).toHaveBeenCalledTimes(1)
    expect(h.movesReplayed).not.toHaveBeenCalled()

    await act(async () => rebuilt())
    await vi.waitFor(() => expect(h.movesReplayed).toHaveBeenCalledTimes(1))
    expect(h.settle).toHaveBeenCalledTimes(2)
    expect(h.settle.mock.invocationCallOrder[1]).toBeLessThan(
      h.movesReplayed.mock.invocationCallOrder[0],
    )
  })

  it("tells boot there is nothing to replay where the profile has no sUSDS deployment", async () => {
    h.tuple.mockResolvedValueOnce(undefined)
    await act(async () => root.render(<WebSavingsProvider>{null}</WebSavingsProvider>))
    await vi.waitFor(() => expect(h.movesReplayed).toHaveBeenCalledTimes(1))
    expect(h.settle).not.toHaveBeenCalled()
  })

  it("releases the balance after a failed replay, and tries the replay again", async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      h.whenReady.mockResolvedValue(undefined)
      h.savingsToken.mockRejectedValueOnce(new Error("node down"))
      await act(async () => root.render(<WebSavingsProvider>{null}</WebSavingsProvider>))
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
      expect(h.movesReplayed).toHaveBeenCalledTimes(1)
      const passes = h.settle.mock.calls.length
      await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)))
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
      expect(h.savingsToken).toHaveBeenCalledTimes(2)
      expect(h.settle.mock.calls.length).toBeGreaterThan(passes)
    } finally {
      vi.mocked(console.warn).mockRestore()
      vi.useRealTimers()
    }
  })

  it("settles once the source is up, and again the moment a rescan rebuilds a Sky burn", async () => {
    await act(async () => root.render(<WebSavingsProvider>{null}</WebSavingsProvider>))
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledTimes(1))
    // A plain burn is no move: nothing to settle.
    await act(async () => void (await withdrawals.create(burn("w-plain", false))))
    expect(h.settle).toHaveBeenCalledTimes(1)
    // A rebuilt Sky burn the store does not know: a pass runs now, not on the next tick.
    await act(async () => void (await withdrawals.create(burn("w-sky", true))))
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledTimes(2))
  })

  it("reads the sUSDS deployment again after a failed read, and settles once it answers", async () => {
    vi.useFakeTimers()
    try {
      h.tuple.mockRejectedValueOnce(new Error("manifest unreachable"))
      vi.spyOn(console, "warn").mockImplementation(() => {})
      await act(async () => root.render(<WebSavingsProvider>{null}</WebSavingsProvider>))
      expect(h.settle).not.toHaveBeenCalled()
      await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)))
      expect(h.tuple).toHaveBeenCalledTimes(2)
      expect(h.settle).toHaveBeenCalledTimes(1)
    } finally {
      vi.mocked(console.warn).mockRestore()
      vi.useRealTimers()
    }
  })

  it.each([
    ["failed", 1],
    ["l2_mined", 4],
  ] as const)(
    "with a pending move whose burn is %s, settles %i times over 90 seconds",
    async (phase, passes) => {
      vi.useFakeTimers()
      try {
        await moves.put({
          direction: "in",
          withdrawalLocalId: "w-move",
          escrow: `0x${"e1".repeat(20)}`,
          nonce: `0x${"03".repeat(32)}`,
          recipientCommitment: `0x${"2c".repeat(32)}`,
          amount: "1",
          startTime: 1,
        })
        await withdrawals.create({ ...burn("w-move", true), phase })
        await act(async () => root.render(<WebSavingsProvider>{null}</WebSavingsProvider>))
        await act(async () => void (await vi.advanceTimersByTimeAsync(90_000)))
        expect(h.settle).toHaveBeenCalledTimes(passes)
      } finally {
        await moves.remove("w-move")
        vi.useRealTimers()
      }
    },
  )
})
