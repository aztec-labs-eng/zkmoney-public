/**
 * What the web withdraw rail persists about a mined burn. The tip is the load-bearing part: the
 * executor pays it out of the burned amount, and the record is the only place the sheet can learn
 * what the recipient is left with, since nothing reads it back off chain.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../src/platform/storage/walletStorage"
import { getAddress, parseUnits, type Address, type Hex } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { ScannedWithdrawEvent } from "@obsidion/sdk"
import {
  deriveBootstrapKey,
  deriveSwapEscrowRecoverySalt,
  withdrawalAmounts,
} from "@obsidion/front-core"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"

const L2_TX = `0x${"0a".repeat(32)}` as Hex
// What the stubbed portal reads back as FPC_FUNDING_CUT — every route records it.
const CUT = 250_000_000_000_000_000n
// The tip a swap commits to is whatever the confirm step's simulation said; the gateway takes it as given.
const RELAYER_TIP = 3n * 10n ** 18n
const SWAP_COMMIT = { relayerTip: RELAYER_TIP, amountOut: 96_000_000n, decimals: 6 }
const RECIPIENT = `0x${"dd".repeat(20)}` as Address
// The wallet's Oxide account, as the stubbed account factory predicts it.
const ACCOUNT = getAddress(`0x${"ac".repeat(20)}`)
const SWAP_TUPLE = {
  swapEscrowFactory: `0x${"fa".repeat(20)}`,
  accountFactory: `0x${"af".repeat(20)}`,
  portal: `0x${"70".repeat(20)}`,
  token: `0x${"da".repeat(20)}`,
  // Leading byte below the BN254 modulus — AztecAddress rejects anything at or above the field.
  l2Broadcaster: `0x${"1b".repeat(32)}`,
}
// What the stubbed portal answers the sdk's pre-burn relayer-tip check with.
const PORTAL_STATE = { fpcFundingCut: CUT, frozen: false }

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
  l1Transport: () => ({}),
}))
// The portal alone resolves no withdrawal wiring, so the chain watcher is skipped, and it is what
// every route's FPC-cut read needs. Swap tests override the tuple per-test via mockTuple.
const PORTAL_ONLY = { portal: `0x${"70".repeat(20)}` }
const mockTuple = vi.fn<() => Record<string, string>>(() => ({ ...PORTAL_ONLY }))
// Only the seams that would dial the network are stubbed; `requireTupleField` stays REAL, so the
// thin-manifest tests below assert the message and the rejection rule production actually has.
// Every route reads the portal's FPC funding cut and whether it is frozen; a swap also asks the
// account factory for the wallet's account.
const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
  functionName === "$frozen" ? false : functionName === "predictAccountAddress" ? ACCOUNT : CUT,
)
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => mockTuple(),
  l1PublicClient: () => ({ readContract }),
}))
vi.mock("../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({ fpcAddress: {}, policy: {} }),
  noteSubscribed: vi.fn(),
}))
vi.mock("../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: vi.fn() }))
// The escrow's recovery account and salt derive from the passkey secret; an unlocked session
// answers it.
const MASTER_SECRET = { toString: () => `0x${"11".repeat(32)}` }
const mockSecretKey = vi.fn(async () => MASTER_SECRET as never)
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: mockSecretKey }),
}))

// planSwapOnWithdraw stays real, which is what makes the escrow assertions below meaningful. The
// rescan's event source reads PXE; the test hands it the events directly.
const scannedEvents = vi.fn<() => ScannedWithdrawEvent[]>(() => [])
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  createWithdrawEventSource: vi.fn(() => ({
    headBlock: async () => 100,
    listWithdrawals: async () => scannedEvents(),
    blockTimestampMs: async () => 1_234_000,
  })),
}))

const { getWithdrawalStore, planSwapLeg, rescanWithdrawals, submitSponsoredWithdrawal } =
  await import("../src/features/withdraw/withdrawGateway")

const { getOperationStore } = await import("../src/features/operations/operations")

const deps = () =>
  ({
    wallet: { node: { getContract: async () => ({}) }, pxe: {} },
    account: { getAddress: () => ({ toString: () => "0xuser" }) },
    contractService: {},
    screener: { screen: async () => ({ compliant: true }) },
    tokenService: {
      fetchTokenInformation: async () => ({ symbol: "DAI" }),
      exitToL1PrivateSponsored: vi.fn(async () => ({
        txHash: L2_TX,
        blockNumber: 42,
        amount: parseUnits("120", 18),
        humanReadableAmount: "120",
        l1Recipient: RECIPIENT,
      })),
    },
  } as unknown as Parameters<typeof submitSponsoredWithdrawal>[0])

describe("submitSponsoredWithdrawal", () => {
  beforeEach(async () => {
    localStorage.clear()
    await getWithdrawalStore().clearAll()
    mockTuple.mockReturnValue({ ...PORTAL_ONLY })
  })

  it("records both halves of the fee beside the amount the burn removed", async () => {
    const record = await submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn())

    expect(record.phase).toBe("l2_mined")
    expect(record.rawAmount).toBe(parseUnits("120", 18).toString())
    expect(record.relayerTip).toBe(WITHDRAW_RELAYER_TIP.toString())
    expect(record.fpcFundingCut).toBe(CUT.toString())
    const stored = getWithdrawalStore().get(record.localId)
    expect(stored?.relayerTip).toBe(WITHDRAW_RELAYER_TIP.toString())
    expect(stored?.fpcFundingCut).toBe(CUT.toString())
  })

  it("stamps the recipient alias onto the record", async () => {
    const record = await submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn(), "Rainbow")
    expect(record.recipientAlias).toBe("Rainbow")
  })

  it("keeps the seeded tip on a pre-mine failure; the sheet hides the breakdown by phase", async () => {
    const failing = deps()
    failing.tokenService.exitToL1PrivateSponsored = (async () => {
      throw new Error("Passkey assertion returned no credential")
    }) as never

    await expect(submitSponsoredWithdrawal(failing, RECIPIENT, "120", vi.fn())).rejects.toThrow(
      /Passkey/,
    )

    const [record] = getWithdrawalStore().list()
    expect(record?.phase).toBe("failed")
    expect(record?.relayerTip).toBe(WITHDRAW_RELAYER_TIP.toString())
  })

  it("writes the burn's hash onto the record at submit, so a reload can still track it", async () => {
    const d = deps()
    let atSubmit: string | undefined
    d.tokenService.exitToL1PrivateSponsored = (async (
      _to: unknown,
      _amount: unknown,
      _sponsor: unknown,
      opts: { operationId: string },
    ) => {
      provingProgress.emitStageStart(ProvingStage.Mining, opts.operationId, L2_TX)
      await new Promise((r) => setTimeout(r, 0))
      atSubmit = getWithdrawalStore().list()[0]?.l2TxHash
      return { txHash: L2_TX, blockNumber: 42, amount: parseUnits("120", 18) }
    }) as never

    await submitSponsoredWithdrawal(d, RECIPIENT, "120", vi.fn())
    expect(atSubmit).toBe(L2_TX)
  })

  it("keeps a burn that reached the node when the call then fails", async () => {
    const d = deps()
    ;(d.wallet as unknown as { node: object }).node = {
      getTxReceipt: vi.fn(async () => ({ status: "pending" })),
    }
    d.tokenService.exitToL1PrivateSponsored = (async (
      _to: unknown,
      _amount: unknown,
      _sponsor: unknown,
      opts: { operationId: string },
    ) => {
      provingProgress.emitStageStart(ProvingStage.Mining, opts.operationId, L2_TX)
      throw new Error("fetch failed")
    }) as never

    const record = await submitSponsoredWithdrawal(d, RECIPIENT, "120", vi.fn())
    expect(record).toMatchObject({ phase: "submitting", l2TxHash: L2_TX })
    expect(getWithdrawalStore().get(record.localId)?.error).toBeUndefined()
    // Left to the chain: the operation is sent, and no flow owns it any more.
    const ops = getOperationStore()
    expect(ops.get(record.operationId!)).toMatchObject({ state: "sent", txHash: L2_TX })
    expect(ops.isLive(record.operationId!)).toBe(false)
  })

  it("keeps a mined burn at l2_mined when the watcher boot rejects after markMined", async () => {
    // The boot is memoized per module; a fresh import guarantees the withdrawal path is the one
    // that boots it. The first two tuple reads price the fee and stamp the deployment pre-record;
    // the third is the boot.
    vi.resetModules()
    const fresh = await import("../src/features/withdraw/withdrawGateway")
    mockTuple
      .mockReturnValueOnce({ ...PORTAL_ONLY })
      .mockReturnValueOnce({ ...PORTAL_ONLY })
      .mockImplementation(() => {
        throw new Error("manifest 503")
      })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    try {
      const record = await fresh.submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn())

      expect(record.phase).toBe("l2_mined")
      const stored = fresh.getWithdrawalStore().get(record.localId)
      expect(stored?.phase).toBe("l2_mined")
      expect(stored?.l2TxHash).toBe(L2_TX)
      expect(stored?.error).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("watcher arm failed"),
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it("drops the seeded record when the stage callback cancels before the burn", async () => {
    const cancel = (stage: string) => {
      if (stage === "proving") throw new Error("Cancelled")
    }
    await expect(submitSponsoredWithdrawal(deps(), RECIPIENT, "120", cancel)).rejects.toThrow(
      /Cancelled/,
    )
    expect(getWithdrawalStore().list()).toHaveLength(0)
  })

  it("leaves the withdraw meta and the release broadcast to the sdk", async () => {
    const d = deps()
    await submitSponsoredWithdrawal(d, RECIPIENT, "120", vi.fn())
    const exitOpts = (d.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>).mock
      .calls[0]![3] as { meta?: unknown; teeUnsignedInteractions?: unknown[] }
    expect(exitOpts.meta).toBeUndefined()
    expect(exitOpts.teeUnsignedInteractions).toBeUndefined()
  })

  it("settles the direct DAI path on the live portal, with no swap", async () => {
    const d = deps()
    const record = await submitSponsoredWithdrawal(d, RECIPIENT, "120", vi.fn())
    expect(record.swapOutput).toBeUndefined()
    expect(record.swapEscrow).toBeUndefined()
    expect(record.swapNonce).toBeUndefined()
    const [burnRecipient, , , exitOpts] = (
      d.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>
    ).mock.calls[0]! as [{ toString(): string }, unknown, unknown, { withdrawal: unknown }]
    expect(burnRecipient.toString().toLowerCase()).toBe(RECIPIENT)
    expect(exitOpts.withdrawal).toEqual({ tuple: PORTAL_ONLY, portal: PORTAL_STATE })
  })

  it("burns and records the prover tip it is given, and none by default", async () => {
    const tip = parseUnits("2", 18)
    const d = deps()
    const record = await submitSponsoredWithdrawal(
      d,
      RECIPIENT,
      "120",
      vi.fn(),
      undefined,
      "DAI",
      undefined,
      tip,
    )
    const exit = d.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>
    expect((exit.mock.calls[0]![3] as { proverTip?: bigint }).proverTip).toBe(tip)
    expect(record.proverTip).toBe(tip.toString())
    expect(withdrawalAmounts(record).netAtomic).toBe(
      parseUnits("120", 18) - tip - CUT - WITHDRAW_RELAYER_TIP,
    )

    const plain = deps()
    const untipped = await submitSponsoredWithdrawal(plain, RECIPIENT, "120", vi.fn())
    const plainExit = plain.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>
    expect((plainExit.mock.calls[0]![3] as { proverTip?: bigint }).proverTip).toBe(0n)
    expect(untipped.proverTip).toBeUndefined()
  })

  // A stale sheet or a direct caller reaches the gateway with whatever amount it holds.
  it("burns exactly $2,500 and refuses one atomic unit more before screening, recording or burning", async () => {
    const exact = deps()
    await submitSponsoredWithdrawal(exact, RECIPIENT, "2500", vi.fn())
    const exit = exact.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>
    expect(exit.mock.calls[0]![1]).toBe(parseUnits("2500", 18).toString())
    await getWithdrawalStore().clearAll()

    const over = deps()
    const screen = vi.spyOn(over.screener, "screen")
    const run = submitSponsoredWithdrawal(over, RECIPIENT, "2500.000000000000000001", vi.fn())
    await expect(run).rejects.toThrow("This withdrawal is over the $2,500 limit, fees included.")
    expect(screen).not.toHaveBeenCalled()
    expect(over.tokenService.exitToL1PrivateSponsored).not.toHaveBeenCalled()
    expect(getWithdrawalStore().list()).toHaveLength(0)
    expect(
      getOperationStore()
        .list()
        .filter((op) => op.state === "local"),
    ).toHaveLength(0)
  })
})

describe("submitSponsoredWithdrawal — swap-on-withdraw", () => {
  beforeEach(async () => {
    localStorage.clear()
    await getWithdrawalStore().clearAll()
    mockTuple.mockReturnValue(SWAP_TUPLE)
  })

  it("burns to the planned escrow with the broadcast riding the same tx", async () => {
    const d = deps()
    const record = await submitSponsoredWithdrawal(
      d,
      RECIPIENT,
      "120",
      vi.fn(),
      undefined,
      "USDC",
      SWAP_COMMIT,
    )

    // The burn recipient is the escrow, never the user's wallet — that stays on the record.
    const exitCall = (d.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>).mock
      .calls[0]!
    const burnRecipient = exitCall[0] as { toString(): string }
    expect(record.recipient).toBe(RECIPIENT)
    expect(record.swapEscrow?.toLowerCase()).toBe(burnRecipient.toString().toLowerCase())
    expect(record.swapEscrow?.toLowerCase()).not.toBe(RECIPIENT.toLowerCase())

    expect(record.swapOutput).toBe("USDC")
    expect(record.swapNonce).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(record.swapRelayerTip).toBe(RELAYER_TIP.toString())
    expect(record.phase).toBe("l2_mined")

    // The escrow commits to this wallet's Oxide account under a salt only its secret re-derives,
    // and to the factory its address came from — both stored, so a later recovery targets the same
    // escrow.
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SWAP_TUPLE.accountFactory,
        functionName: "predictAccountAddress",
        args: [deriveBootstrapKey(MASTER_SECRET).address],
      }),
    )
    expect(record.swapRecoveryCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(record.swapEscrowFactory).toBe(SWAP_TUPLE.swapEscrowFactory)

    // The sdk pairs the escrow's swap with the release, and writes the escrow args into the meta
    // a rescan rebuilds this record from.
    expect((exitCall[3] as { withdrawal?: unknown }).withdrawal).toEqual({
      tuple: SWAP_TUPLE,
      portal: PORTAL_STATE,
      swap: expect.objectContaining({
        escrow: record.swapEscrow,
        escrowArgs: {
          route: expect.any(Number),
          recipient: RECIPIENT,
          recoveryCommitment: record.swapRecoveryCommitment,
          relayerTip: RELAYER_TIP,
          nonce: record.swapNonce,
        },
        recovery: {
          account: ACCOUNT,
          salt: deriveSwapEscrowRecoverySalt(MASTER_SECRET, record.swapNonce!),
        },
      }),
    })
    expect((exitCall[3] as { meta?: unknown }).meta).toBeUndefined()
  })

  it("plans the escrow net of the prover tip the burn carries", async () => {
    const tip = parseUnits("2", 18)
    const d = deps()
    const record = await submitSponsoredWithdrawal(
      d,
      RECIPIENT,
      "120",
      vi.fn(),
      undefined,
      "USDC",
      SWAP_COMMIT,
      tip,
    )
    const exit = d.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>
    expect((exit.mock.calls[0]![3] as { proverTip?: bigint }).proverTip).toBe(tip)
    expect(record.proverTip).toBe(tip.toString())

    // A tip that leaves the escrow nothing to swap fails the plan before anything is stored.
    const eaten = parseUnits("120", 18) - WITHDRAW_RELAYER_TIP - CUT - RELAYER_TIP
    await getWithdrawalStore().clearAll()
    const rejected = deps()
    await expect(
      submitSponsoredWithdrawal(
        rejected,
        RECIPIENT,
        "120",
        vi.fn(),
        undefined,
        "USDC",
        SWAP_COMMIT,
        eaten,
      ),
    ).rejects.toThrow("nothing left to swap")
    expect(rejected.tokenService.exitToL1PrivateSponsored).not.toHaveBeenCalled()
    expect(getWithdrawalStore().list()).toHaveLength(0)
  })

  it("rebuilds the records a rescan finds and skips the burns already stored", async () => {
    walletStorage.setItem(
      "webwallet.identity",
      JSON.stringify({ address: `0x${"1a".repeat(32)}`, claimedAt: 0 }),
    )
    const d = deps()
    const known = await submitSponsoredWithdrawal(
      d,
      RECIPIENT,
      "120",
      vi.fn(),
      undefined,
      "USDC",
      SWAP_COMMIT,
    )
    scannedEvents.mockReturnValue([
      {
        txHash: known.l2TxHash!,
        blockNumber: 42,
        l1Recipient: known.swapEscrow!,
        amount: parseUnits("120", 18),
      },
      {
        txHash: `0x${"0b".repeat(32)}`,
        blockNumber: 50,
        l1Recipient: known.swapEscrow!,
        amount: parseUnits("60", 18),
        swap: {
          output: "USDC",
          recipient: RECIPIENT,
          factory: getAddress(SWAP_TUPLE.swapEscrowFactory),
          recoveryCommitment: known.swapRecoveryCommitment!,
          relayerTip: RELAYER_TIP,
          nonce: known.swapNonce!,
        },
      },
    ])

    const rebuilt = await rescanWithdrawals(d.wallet, d.tokenService)

    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0]).toMatchObject({
      l2TxHash: `0x${"0b".repeat(32)}`,
      phase: "l2_mined",
      amount: "60",
      recipient: RECIPIENT,
      swapEscrow: known.swapEscrow,
      swapNonce: known.swapNonce,
      swapRecoveryCommitment: known.swapRecoveryCommitment,
      startTime: 1_234_000,
      rebuilt: true,
    })
    expect(getWithdrawalStore().list()).toHaveLength(2)
    // Memoized per page load: a second call is the same pass.
    expect(await rescanWithdrawals(d.wallet, d.tokenService)).toBe(rebuilt)
  })

  it("persists the FPC cut and the confirm-time simulation for the detail sheet", async () => {
    const record = await submitSponsoredWithdrawal(
      deps(),
      RECIPIENT,
      "120",
      vi.fn(),
      undefined,
      "ETH",
      { relayerTip: RELAYER_TIP, amountOut: parseUnits("0.5", 18), decimals: 18 },
    )

    const stored = getWithdrawalStore().get(record.localId)
    expect(stored?.fpcFundingCut).toBe(CUT.toString()) // the stubbed portal read
    expect(stored?.swapRelayerTip).toBe(RELAYER_TIP.toString())
    expect(stored?.swapEstimatedOut).toBe(parseUnits("0.5", 18).toString())
    expect(stored?.swapOutputDecimals).toBe(18)
  })

  it("refuses a swap without a simulated tip, before any record exists", async () => {
    await expect(
      submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn(), undefined, "USDC"),
    ).rejects.toThrow(/Swap fee unavailable/)
    expect(getWithdrawalStore().list()).toHaveLength(0)
  })

  it("fails before any record exists when the manifest names no factory", async () => {
    mockTuple.mockReturnValue({ l2Broadcaster: SWAP_TUPLE.l2Broadcaster })
    await expect(
      submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn(), undefined, "ETH", SWAP_COMMIT),
    ).rejects.toThrow(/swapEscrowFactory/)
    expect(getWithdrawalStore().list()).toHaveLength(0)
  })

  it("fails before any record exists while the wallet is locked — no recoverer, no escrow", async () => {
    mockSecretKey.mockResolvedValueOnce(undefined as never)
    await expect(
      submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn(), undefined, "USDC", SWAP_COMMIT),
    ).rejects.toThrow(/Unlock your wallet/)
    expect(getWithdrawalStore().list()).toHaveLength(0)
  })

  it("fails before any record exists when the manifest names no account factory", async () => {
    mockTuple.mockReturnValue({ ...SWAP_TUPLE, accountFactory: "" })
    await expect(
      submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn(), undefined, "USDC", SWAP_COMMIT),
    ).rejects.toThrow(/accountFactory/)
    expect(getWithdrawalStore().list()).toHaveLength(0)
  })

  it("fails before any record exists when the manifest names no broadcaster", async () => {
    mockTuple.mockReturnValue({ ...SWAP_TUPLE, l2Broadcaster: "" })
    await expect(
      submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn(), undefined, "USDT", SWAP_COMMIT),
    ).rejects.toThrow(/l2Broadcaster/)
    expect(getWithdrawalStore().list()).toHaveLength(0)
  })
})

describe("planSwapLeg", () => {
  it("commits to a given recoverer, salted from its secret, without the wallet's", async () => {
    mockTuple.mockReturnValue(SWAP_TUPLE)
    mockSecretKey.mockClear()
    readContract.mockClear()
    const secret = { toString: () => `0x${"22".repeat(32)}` }
    const leg = await planSwapLeg(
      {} as never,
      "USDC",
      RECIPIENT,
      parseUnits("120", 18),
      SWAP_COMMIT,
      { account: RECIPIENT, secret },
    )

    expect(leg!.plan.recovery).toEqual({
      account: RECIPIENT,
      salt: deriveSwapEscrowRecoverySalt(secret, leg!.plan.escrowArgs.nonce),
    })
    expect(mockSecretKey).not.toHaveBeenCalled()
    expect(readContract).not.toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "predictAccountAddress" }),
    )
  })
})
