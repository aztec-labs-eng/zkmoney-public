/**
 * The web side of the self-finalize exit: who it refuses, how each classified builder failure is
 * worded, who takes the relayer tip, the phase-preserving record patch, and the two submission
 * channels — including that the desktop one asks for no address, because the burn already named
 * the recipient.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import type { WithdrawalRecord } from "@obsidion/front-core"

const PORTAL = `0x${"cc".repeat(20)}` as Address
const RECIPIENT = `0x${"dd".repeat(20)}` as Address
const WALLET = `0x${"44".repeat(20)}` as Address
const BURN_TX = `0x${"0a".repeat(32)}` as Hex
const WITHDRAWAL_ID = `0x${"c1".repeat(32)}` as Hex
const L1_TX = `0x${"ab".repeat(32)}` as Hex
const CALLDATA = "0xdeadbeef" as Hex

const l1Clients = vi.hoisted(() => ({ getL1Clients: vi.fn() }))
const bridge = vi.hoisted(() => ({
  submitViaDesktopBridge: vi.fn(),
  isDesktopL1SubmitActive: vi.fn(() => false),
}))

vi.mock("../src/features/deposit/l1Wallet", () => l1Clients)
vi.mock("../src/platform/desktopBridge", () => bridge)

const { WithdrawFinalizationError } = await import("@obsidion/sdk")
const { finalizeChannel, selfFinalizeWithdrawal } = await import(
  "../src/features/withdraw/selfFinalize"
)

const PORTAL_CONTEXT = {
  l1Portal: PORTAL,
  l2Portal: `0x${"0b".repeat(32)}`,
  rollupVersion: 1n,
  l1ChainId: 11155111n,
}

const record = (patch: Partial<WithdrawalRecord> = {}): WithdrawalRecord => ({
  localId: "wdraw_1",
  recipient: RECIPIENT,
  recipientProvenance: "saved-recipient",
  amount: "210",
  tokenSymbol: "DAI",
  phase: "finalizing_l1",
  startTime: 1_700_000_000_000,
  l2TxHash: BURN_TX,
  withdrawalId: WITHDRAWAL_ID,
  ...patch,
})

describe("selfFinalizeWithdrawal", () => {
  const channel = {
    target: WALLET,
    sendTransaction: vi.fn(async () => L1_TX),
    waitForReceipt: vi.fn(async () => true),
  }
  const store = { patch: vi.fn(), get: vi.fn(() => null as WithdrawalRecord | null) }

  const deps = (
    over: {
      spent?: boolean
      isSpent?: () => Promise<boolean>
      build?: () => Promise<unknown>
    } = {},
  ) => ({
    channel,
    portalContext: PORTAL_CONTEXT,
    l1: {} as never,
    store: store as never,
    isSpent: vi.fn(over.isSpent ?? (async () => over.spent ?? false)),
    build: (over.build ??
      vi.fn(async () => ({ to: PORTAL, data: CALLDATA, withdrawalId: WITHDRAWAL_ID }))) as never,
  })

  const throwing = (err: unknown) => () => Promise.reject(err)

  beforeEach(() => {
    vi.clearAllMocks()
    channel.sendTransaction.mockResolvedValue(L1_TX)
    channel.waitForReceipt.mockResolvedValue(true)
    store.get.mockReturnValue(null)
  })

  it("refuses a withdrawal with no burn transaction to re-derive from", async () => {
    const d = deps()
    await expect(selfFinalizeWithdrawal(record({ l2TxHash: undefined }), d)).rejects.toThrow(
      /nothing to finalize/,
    )
    expect(d.isSpent).not.toHaveBeenCalled()
  })

  it("aborts before the expensive build when the withdrawal is already released", async () => {
    const d = deps({ spent: true })
    await expect(selfFinalizeWithdrawal(record(), d)).rejects.toThrow(/A relayer finalized this/)
    expect(d.build).not.toHaveBeenCalled()
    expect(d.isSpent).toHaveBeenCalledWith({}, PORTAL, WITHDRAWAL_ID)
  })

  it("skips the pre-flight for a record whose withdrawalId is not derived yet", async () => {
    const d = deps()
    await selfFinalizeWithdrawal(record({ withdrawalId: undefined }), d)
    expect(d.isSpent).not.toHaveBeenCalled()
    expect(d.build).toHaveBeenCalled()
  })

  it.each([
    ["already-finalized", /A relayer finalized this/],
    ["not-yet-finalizable", /can't be finalized yet/],
    ["enclave-unavailable", /signing service is unreachable/],
  ] as const)("words a %s build failure honestly", async (reason, message) => {
    const d = deps({ build: throwing(new WithdrawFinalizationError(reason, "raw")) })
    await expect(selfFinalizeWithdrawal(record(), d)).rejects.toThrow(message)
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("keeps an unclassified build failure's own message", async () => {
    const d = deps({ build: throwing(new Error("node unreachable")) })
    await expect(selfFinalizeWithdrawal(record(), d)).rejects.toThrow(/node unreachable/)
  })

  it("names the submitting channel's account as the relayer tip's recipient", async () => {
    const d = deps()
    await selfFinalizeWithdrawal(record(), d)
    expect(d.build).toHaveBeenCalledWith(BURN_TX, WALLET)
  })

  it("submits the built portal call and marks it in flight without advancing the phase", async () => {
    const d = deps()
    await expect(selfFinalizeWithdrawal(record(), d)).resolves.toBe(L1_TX)
    expect(channel.sendTransaction).toHaveBeenCalledWith(PORTAL, CALLDATA)
    // Only the tracker's own `isSpent` pass writes `done` — this receipt is not proof of release.
    expect(store.patch).toHaveBeenCalledWith(BURN_TX, {
      phase: "finalizing_l1",
      finalizeTxHash: L1_TX,
      reorgEpoch: undefined,
    })
  })

  it("carries the record's reorg epoch so a demote fences the write", async () => {
    await selfFinalizeWithdrawal(record({ reorgEpoch: 3 }), deps())
    expect(store.patch).toHaveBeenCalledWith(BURN_TX, expect.objectContaining({ reorgEpoch: 3 }))
  })

  it("takes the phase and the epoch the store holds when the receipt returns, not the snapshot", async () => {
    // The tracker owns both, and it runs while the receipt is awaited: a release it confirmed must
    // not rewind to `finalizing_l1`, and a demote it wrote must keep fencing.
    store.get.mockReturnValue(record({ phase: "done", reorgEpoch: 2 }))
    await selfFinalizeWithdrawal(record({ reorgEpoch: 1 }), deps())
    expect(store.patch).toHaveBeenCalledWith(BURN_TX, {
      phase: "done",
      finalizeTxHash: L1_TX,
      reorgEpoch: 2,
    })
  })

  it("reports a reverted finalization as having moved nothing, and writes nothing", async () => {
    channel.waitForReceipt.mockResolvedValue(false)
    const d = deps()
    const message = await selfFinalizeWithdrawal(record(), d).catch((e: Error) => e.message)
    expect(message).toMatch(/reverted/)
    expect(message).toMatch(/still finalizable/)
    expect(message).not.toMatch(/relayer/)
    // Re-read off the id the build derived, not the record's.
    expect(d.isSpent).toHaveBeenLastCalledWith({}, PORTAL, WITHDRAWAL_ID)
    expect(store.patch).not.toHaveBeenCalled()
  })

  it("words a revert as a lost race when the withdrawal has since been released", async () => {
    // The portal reverts a finalize a relayer beat to the release.
    channel.waitForReceipt.mockResolvedValue(false)
    let reads = 0
    const d = deps({ isSpent: async () => reads++ > 0 })
    await expect(selfFinalizeWithdrawal(record(), d)).rejects.toThrow(/A relayer finalized this/)
    expect(store.patch).not.toHaveBeenCalled()
  })

  it("keeps the revert wording when the post-revert read fails", async () => {
    channel.waitForReceipt.mockResolvedValue(false)
    let reads = 0
    const d = deps({
      isSpent: async () => {
        if (reads++ > 0) throw new Error("rpc down")
        return false
      },
    })
    await expect(selfFinalizeWithdrawal(record(), d)).rejects.toThrow(/still finalizable/)
  })
})

describe("finalizeChannel", () => {
  const config = { l1ChainId: 11155111, l1RpcUrl: "http://l1" } as never

  beforeEach(() => {
    vi.clearAllMocks()
    bridge.isDesktopL1SubmitActive.mockReturnValue(false)
  })

  it("signs with the connected account in a browser with an injected wallet", async () => {
    l1Clients.getL1Clients.mockResolvedValue({
      walletClient: { sendTransaction: vi.fn(async () => L1_TX) },
      publicClient: { waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })) },
      account: WALLET,
      chain: { id: 11155111 },
    })
    const channel = await finalizeChannel({
      config,
      record: record(),
      publicClient: {} as never,
      opts: { from: WALLET },
    })
    expect(channel.target).toBe(WALLET)
    expect(l1Clients.getL1Clients).toHaveBeenCalledWith(11155111, WALLET)
  })

  it("takes no address in the desktop launcher — the burn already named the recipient", async () => {
    bridge.isDesktopL1SubmitActive.mockReturnValue(true)
    bridge.submitViaDesktopBridge.mockResolvedValue(L1_TX)
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "success" }))
    // No `destination` option exists to pass, and none is required.
    const channel = await finalizeChannel({
      config,
      record: record(),
      publicClient: { waitForTransactionReceipt } as never,
      opts: {},
    })

    // The helper page's account is unknown when the calldata is built, so the recipient is tipped.
    expect(channel.target).toBe(RECIPIENT)
    await expect(channel.sendTransaction(PORTAL, CALLDATA)).resolves.toBe(L1_TX)
    const params = bridge.submitViaDesktopBridge.mock.calls[0]![0]
    expect(params.tx).toEqual({ to: PORTAL, data: CALLDATA, chainId: 11155111 })
    expect(params.display.title).toBe("Finalize your zk.money withdrawal")
    expect(Object.fromEntries(params.display.lines)).toEqual({
      Amount: "210 DAI",
      Recipient: RECIPIENT,
      Network: "Sepolia",
    })
    await expect(channel.waitForReceipt(L1_TX)).resolves.toBe(true)
  })

  it("tips a swap's recipient in the desktop launcher, never the escrow the burn pays", async () => {
    bridge.isDesktopL1SubmitActive.mockReturnValue(true)
    const escrow = `0x${"e5".repeat(20)}` as Address
    const channel = await finalizeChannel({
      config,
      record: record({ swapOutput: "USDC", swapEscrow: escrow }),
      publicClient: {} as never,
      opts: {},
    })
    expect(channel.target).toBe(RECIPIENT)
  })
})
