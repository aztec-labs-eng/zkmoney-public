/**
 * What the paylink L1 claim hands to the burn and persists. The swap route mirrors a balance
 * withdrawal: the burn pays the planned escrow, the sdk pairs its swap with the release in the same
 * tx, and the record carries the escrow args plus the confirm-time quote the detail sheet renders.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { formatUnits, parseUnits, type Address, type Hex } from "viem"
import { DEFAULT_CONTRACTS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import { TxStatus } from "@aztec/stdlib/tx"

const RELAYER_TIP = 5n * 10n ** 18n
const SWAP_COMMIT = { relayerTip: RELAYER_TIP, amountOut: 1n, decimals: 18 }
const L2_TX = `0x${"0a".repeat(32)}` as Hex
const RECIPIENT = `0x${"dd".repeat(20)}` as Address
// The claimer's Oxide account, as the stubbed account factory predicts it.
const ACCOUNT = `0x${"ac".repeat(20)}` as Address
// What the stubbed portal reads back as FPC_FUNDING_CUT — half the fee on every route.
const CUT = 250_000_000_000_000_000n
const SWAP_TUPLE = {
  l2Token: `0x${"11".repeat(32)}`,
  swapEscrowFactory: `0x${"fa".repeat(20)}`,
  accountFactory: `0x${"af".repeat(20)}`,
  portal: `0x${"70".repeat(20)}`,
  token: `0x${"da".repeat(20)}`,
  // Leading byte below the BN254 modulus — AztecAddress rejects anything at or above the field.
  l2Broadcaster: `0x${"1b".repeat(32)}`,
}
// What the stubbed portal answers the sdk's pre-burn relayer-tip check with.
const PORTAL_STATE = { fpcFundingCut: CUT, frozen: false }

const link = () => ({
  paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
  secret: { toString: () => "0xsecret", toBuffer: () => new Uint8Array(32) },
  classId: { toString: () => "0x1234" },
  chainId: 31337,
  rollupVersion: 1,
})
const linkParams = link()
// The escrow note the burn spends; the link itself carries no amount.
let escrowAmount = parseUnits("120", 18)

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111, network: "sandbox" }),
  l1Transport: () => ({}),
}))
// The portal alone resolves no withdrawal wiring, so the chain watcher is skipped, and it is what
// every route's FPC-cut read needs; swap tests override the tuple. A swap also asks the account
// factory for the claimer's account, which recovers the escrow.
const PORTAL_ONLY = { portal: `0x${"70".repeat(20)}`, l2Token: SWAP_TUPLE.l2Token }
const mockTuple = vi.fn<() => Record<string, string>>(() => ({ ...PORTAL_ONLY }))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => mockTuple(),
  l1PublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "$frozen" ? false : functionName === "predictAccountAddress" ? ACCOUNT : CUT,
  }),
}))
vi.mock("../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({ fpcAddress: {}, policy: {} }),
  noteSubscribed: vi.fn(),
}))
vi.mock("../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: vi.fn() }))
vi.mock("../src/features/migration/historicTokenContext", () => ({
  findHistoricTuple: vi.fn(),
  historicSponsorTargets: vi.fn(),
  historicTokenContext: vi.fn(),
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    getSecretKey: async () => ({ toString: () => `0x${"07".repeat(32)}` }),
  }),
}))
const firePaylinkEvent = vi.hoisted(() => vi.fn())
vi.mock("../src/lib/analytics", () => ({
  analyticsEnabled: () => true,
  firePaylinkEvent,
  paylinkPh: async () => "ph",
  paylinkAmountBucket: (amount: bigint | undefined) => (amount === undefined ? "unknown" : "<500"),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  upsertSavedL1WalletContact: vi.fn(),
  readPaylinkNote: async () => ({ amount: escrowAmount }),
}))

// The burn is the sdk's; here it only reports a mined tx. planSwapOnWithdraw stays real.
const claimToL1 = vi.fn(async () => ({ txHash: L2_TX, blockNumber: 42 }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  PaylinkService: class {
    claimSponsoredPaylinkToL1 = claimToL1
  },
  decodePaylinkInline: () => linkParams,
  readPaylinkEscrowNote: async () => ({
    amount: escrowAmount,
    tokenAddress: { toString: () => SWAP_TUPLE.l2Token },
  }),
}))

// The burn's own published figures, which the post-mine reconciliation prefers over the caller's.
type Published = { amount: bigint; relayerTip: bigint; proverTip: bigint }
const publishedBurn = vi.fn<() => Promise<Published | undefined>>(async () => undefined)
vi.mock("../src/features/withdraw/withdrawGateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/withdraw/withdrawGateway")>()),
  publishedBurn: () => publishedBurn(),
}))

const recordBurnDuration = vi.hoisted(() => vi.fn(async (_ms: number) => {}))
vi.mock("../src/features/withdraw/burnTiming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/withdraw/burnTiming")>()),
  recordBurnDuration,
}))

const { claimLinkToL1 } = await import("../src/features/paylink/sponsoredPaylink")
const { getWithdrawalStore } = await import("../src/features/withdraw/withdrawGateway")
const { getOperationStore } = await import("../src/features/operations/operations")
const { reportPaylinkClaims } = await import("../src/features/paylink/paylinkClaimReport")
const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")

const deps = () =>
  ({
    wallet: { node: { getContract: async () => ({}) }, pxe: {} },
    account: { getAddress: () => ({ toString: () => "0xuser" }) },
    contractService: {},
    tokenService: { fetchTokenInformation: async () => ({ symbol: "DAI" }) },
    teeSigner: {},
    rollupAddress: {},
  } as unknown as Parameters<typeof claimLinkToL1>[0])
const screener = { screen: async () => ({ compliant: true }) } as never

const burnArgs = () => {
  const [, recipient, opts] = claimToL1.mock.calls[0]! as unknown as [
    unknown,
    { toString(): string },
    { proverTip: bigint; withdrawal: { tuple: unknown; portal: unknown; swap?: unknown } },
  ]
  return { recipient: recipient.toString().toLowerCase(), opts }
}

describe("claimLinkToL1", () => {
  beforeEach(async () => {
    localStorage.clear()
    await getWithdrawalStore().clearAll()
    mockTuple.mockReturnValue({ ...PORTAL_ONLY })
    escrowAmount = parseUnits("120", 18)
    claimToL1.mockClear()
    recordBurnDuration.mockClear()
    firePaylinkEvent.mockClear()
    publishedBurn.mockResolvedValue(undefined)
  })

  it("reports the claimed link once its burn mines, whether directly or after a receipt timeout", async () => {
    await claimLinkToL1(deps(), "frag-direct", RECIPIENT, screener, vi.fn())
    await vi.waitFor(() => expect(firePaylinkEvent).toHaveBeenCalledTimes(1))
    expect(firePaylinkEvent).toHaveBeenCalledWith({
      stage: "claimed",
      flavor: "direct",
      amount_bucket: "<500",
      paylink_ph: "ph",
    })

    firePaylinkEvent.mockClear()
    localStorage.clear()
    await getWithdrawalStore().clearAll()
    claimToL1.mockImplementationOnce(async (...args: unknown[]) => {
      const { operationId } = args[4] as { operationId: string }
      provingProgress.emitStageStart(ProvingStage.Mining, operationId, L2_TX)
      throw new Error("Receipt timed out")
    })
    const d = deps()
    ;(d.wallet as unknown as { node: object }).node = {
      getTxReceipt: vi.fn(async () => ({ status: TxStatus.PENDING })),
    }
    const record = await claimLinkToL1(d, "frag-direct", RECIPIENT, screener, vi.fn())
    await reportPaylinkClaims(getWithdrawalStore().list(), webStorage)
    expect(firePaylinkEvent).not.toHaveBeenCalled()
    await getWithdrawalStore().markMined(record.localId, L2_TX, 42, escrowAmount.toString())
    await reportPaylinkClaims(getWithdrawalStore().list(), webStorage)
    expect(firePaylinkEvent).toHaveBeenCalledTimes(1)
  })

  it("burns straight to the recipient with no swap fields on the direct route", async () => {
    const record = await claimLinkToL1(deps(), "frag-direct", RECIPIENT, screener, vi.fn())

    expect(record.source).toBe("paylink")
    expect(record.phase).toBe("l2_mined")
    expect(record.swapOutput).toBeUndefined()
    expect(record.swapEscrow).toBeUndefined()
    // Both halves of the fee are on the record, and the display amount is net of them.
    expect(record.relayerTip).toBe(WITHDRAW_RELAYER_TIP.toString())
    expect(record.fpcFundingCut).toBe(CUT.toString())
    expect(record.proverTip).toBeUndefined()
    expect(record.amount).toBe(formatUnits(escrowAmount - WITHDRAW_RELAYER_TIP - CUT, 18))
    const { recipient, opts } = burnArgs()
    expect(recipient).toBe(RECIPIENT.toLowerCase())
    // The sdk builds the release broadcast and the meta; the flow passes where the burn settles.
    expect(opts).toEqual({
      proverTip: 0n,
      withdrawal: { tuple: PORTAL_ONLY, portal: PORTAL_STATE },
    })
  })

  it("burns the chosen prover tip, records it, and nets it off the amount", async () => {
    const tip = parseUnits("0.5", 18)
    const record = await claimLinkToL1(
      deps(),
      "frag-tip",
      RECIPIENT,
      screener,
      vi.fn(),
      undefined,
      "DAI",
      undefined,
      undefined,
      undefined,
      tip,
    )
    expect(burnArgs().opts.proverTip).toBe(tip)
    expect(record.proverTip).toBe(tip.toString())
    expect(record.amount).toBe(formatUnits(escrowAmount - WITHDRAW_RELAYER_TIP - CUT - tip, 18))
    expect(recordBurnDuration).toHaveBeenCalledTimes(1)
    expect(recordBurnDuration.mock.calls[0]![0]).toBeGreaterThanOrEqual(0)
  })

  it("refuses a link the fee and the tip would consume, before any record exists", async () => {
    const tip = parseUnits("0.5", 18)
    escrowAmount = WITHDRAW_RELAYER_TIP + CUT + tip
    await expect(
      claimLinkToL1(
        deps(),
        "frag-tip-floor",
        RECIPIENT,
        screener,
        vi.fn(),
        undefined,
        "DAI",
        undefined,
        undefined,
        undefined,
        tip,
      ),
    ).rejects.toThrow(/too little/)
    expect(getWithdrawalStore().list()).toHaveLength(0)
    expect(claimToL1).not.toHaveBeenCalled()
  })

  // The burn spends the whole escrow, so a link over the limit has no smaller amount to send.
  it("claims a link of exactly $2,500 and refuses one atomic unit more before screening or recording", async () => {
    escrowAmount = parseUnits("2500", 18)
    await claimLinkToL1(deps(), "frag-at-limit", RECIPIENT, screener, vi.fn())
    expect(claimToL1).toHaveBeenCalledTimes(1)
    await getWithdrawalStore().clearAll()

    escrowAmount = parseUnits("2500", 18) + 1n
    const screen = vi.fn(async () => ({ compliant: true }))
    const run = claimLinkToL1(deps(), "frag-over-limit", RECIPIENT, { screen } as never, vi.fn())
    await expect(run).rejects.toThrow(
      "This link holds more than the $2,500 withdrawal limit, so it cannot be claimed to an Ethereum wallet.",
    )
    expect(screen).not.toHaveBeenCalled()
    expect(claimToL1).toHaveBeenCalledTimes(1)
    expect(getWithdrawalStore().list()).toHaveLength(0)
    expect(
      getOperationStore()
        .list()
        .filter((op) => op.state === "local"),
    ).toHaveLength(0)
  })

  it("leaves a burn that reached the node to the chain, record and operation both", async () => {
    claimToL1.mockImplementationOnce(async (...args: unknown[]) => {
      const { operationId } = args[4] as { operationId: string }
      provingProgress.emitStageStart(ProvingStage.Mining, operationId, L2_TX)
      throw new Error("Receipt timed out")
    })
    const d = deps()
    ;(d.wallet as unknown as { node: object }).node = {
      getTxReceipt: vi.fn(async () => ({ status: TxStatus.PENDING })),
    }
    const record = await claimLinkToL1(d, "frag-direct", RECIPIENT, screener, vi.fn())
    expect(record).toMatchObject({ phase: "submitting", l2TxHash: L2_TX })
    expect(record.error).toBeUndefined()
    expect(getOperationStore().get(record.operationId!)).toMatchObject({
      state: "sent",
      txHash: L2_TX,
    })
    // Only a burn this flow saw mine has a confirm-to-mined time.
    expect(recordBurnDuration).not.toHaveBeenCalled()
  })

  it("fails the record, and the operation, when the burn fails after proving began", async () => {
    claimToL1.mockImplementationOnce(async (...args: unknown[]) => {
      const { operationId } = args[4] as { operationId: string }
      provingProgress.emitStageStart(ProvingStage.Simulating, operationId)
      await new Promise((r) => setTimeout(r, 0))
      throw new Error("proving died")
    })
    await expect(
      claimLinkToL1(deps(), "frag-direct", RECIPIENT, screener, vi.fn()),
    ).rejects.toThrow("proving died")
    const [record] = getWithdrawalStore().list()
    expect(record).toMatchObject({ phase: "failed", error: "proving died" })
    expect(getOperationStore().get(record!.operationId!)).toMatchObject({
      state: "failed",
      error: "proving died",
    })
  })

  it("stores nothing owed when the burn published less than the fee", async () => {
    const published = parseUnits("0.2", 18)
    publishedBurn.mockResolvedValue({
      amount: published,
      relayerTip: WITHDRAW_RELAYER_TIP,
      proverTip: 0n,
    })

    const record = await claimLinkToL1(deps(), "frag-direct", RECIPIENT, screener, vi.fn())

    const stored = getWithdrawalStore()
      .list()
      .find((r) => r.localId === record.localId)!
    // The portal's cut takes the whole 0.2, leaving nothing for the tip or the recipient — and a
    // record can never carry a negative amount.
    expect(stored.rawAmount).toBe(published.toString())
    expect(stored.amount).toBe("0")
  })

  it("burns to the planned escrow with the broadcast riding the same tx on a swap", async () => {
    mockTuple.mockReturnValue(SWAP_TUPLE)
    const record = await claimLinkToL1(
      deps(),
      "frag-swap",
      RECIPIENT,
      screener,
      vi.fn(),
      "Rainbow",
      "USDC",
      { relayerTip: RELAYER_TIP, amountOut: parseUnits("119", 6), decimals: 6 },
    )

    // The burn recipient is the escrow, never the user's wallet — that stays on the record.
    const { recipient, opts } = burnArgs()
    expect(record.recipient).toBe(RECIPIENT)
    expect(record.recipientAlias).toBe("Rainbow")
    expect(record.swapEscrow?.toLowerCase()).toBe(recipient)
    expect(recipient).not.toBe(RECIPIENT.toLowerCase())
    // The claimer's own account recovers the escrow, not the link's destination.
    expect(opts.withdrawal).toEqual({
      tuple: SWAP_TUPLE,
      portal: PORTAL_STATE,
      swap: expect.objectContaining({
        escrowArgs: expect.objectContaining({ relayerTip: RELAYER_TIP }),
        recovery: expect.objectContaining({ account: ACCOUNT }),
      }),
    })

    const stored = getWithdrawalStore().get(record.localId)
    expect(stored?.swapOutput).toBe("USDC")
    expect(stored?.swapNonce).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(stored?.swapRecoveryCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(stored?.swapRelayerTip).toBe(RELAYER_TIP.toString())
    expect(stored?.fpcFundingCut).toBe(CUT.toString()) // the stubbed portal read
    expect(stored?.swapEstimatedOut).toBe(parseUnits("119", 6).toString())
    expect(stored?.swapOutputDecimals).toBe(6)
    expect(stored?.phase).toBe("l2_mined")
  })

  it("burns to a pre-planned leg's escrow without planning again", async () => {
    const escrow = `0x${"ee".repeat(20)}` as Address
    const leg = {
      output: "USDC",
      source: PORTAL_ONLY,
      plan: {
        escrow,
        escrowArgs: {
          nonce: `0x${"07".repeat(32)}`,
          recoveryCommitment: `0x${"c0".repeat(32)}`,
          relayerTip: RELAYER_TIP,
        },
        recovery: { account: ACCOUNT, salt: { toString: () => "0x5a" } },
      },
      factory: SWAP_TUPLE.swapEscrowFactory,
    } as never
    // No factory in the tuple: planning here would throw, so the leg must be taken as given.
    const record = await claimLinkToL1(
      deps(),
      "frag-planned",
      RECIPIENT,
      screener,
      vi.fn(),
      undefined,
      "USDC",
      SWAP_COMMIT,
      undefined,
      leg,
    )
    const { recipient, opts } = burnArgs()
    expect(recipient).toBe(escrow)
    expect(opts.withdrawal).toEqual({
      tuple: PORTAL_ONLY,
      portal: PORTAL_STATE,
      swap: expect.objectContaining({
        escrowArgs: expect.objectContaining({ relayerTip: RELAYER_TIP }),
      }),
    })
    expect(record.swapEscrow).toBe(escrow)
    expect(record.swapOutput).toBe("USDC")
  })

  it("refuses a link that leaves the escrow nothing to swap, before any record exists", async () => {
    mockTuple.mockReturnValue(SWAP_TUPLE)
    escrowAmount = WITHDRAW_RELAYER_TIP + CUT + RELAYER_TIP
    await expect(
      claimLinkToL1(
        deps(),
        "frag-floor",
        RECIPIENT,
        screener,
        vi.fn(),
        undefined,
        "ETH",
        SWAP_COMMIT,
      ),
    ).rejects.toThrow(/nothing left to swap/)
    expect(getWithdrawalStore().list()).toHaveLength(0)
    expect(claimToL1).not.toHaveBeenCalled()
  })

  it("plans the escrow net of the prover tip the burn carries", async () => {
    mockTuple.mockReturnValue(SWAP_TUPLE)
    const tip = parseUnits("0.5", 18)
    // Enough for the swap without the tip; the tip leaves the escrow nothing.
    escrowAmount = WITHDRAW_RELAYER_TIP + CUT + RELAYER_TIP + tip
    await expect(
      claimLinkToL1(
        deps(),
        "frag-swap-tip",
        RECIPIENT,
        screener,
        vi.fn(),
        undefined,
        "USDC",
        SWAP_COMMIT,
        undefined,
        undefined,
        tip,
      ),
    ).rejects.toThrow(/nothing left to swap/)
    expect(claimToL1).not.toHaveBeenCalled()
  })

  it("fails before any record exists when the manifest names no factory", async () => {
    mockTuple.mockReturnValue({ ...PORTAL_ONLY, l2Broadcaster: SWAP_TUPLE.l2Broadcaster })
    await expect(
      claimLinkToL1(
        deps(),
        "frag-nofactory",
        RECIPIENT,
        screener,
        vi.fn(),
        undefined,
        "ETH",
        SWAP_COMMIT,
      ),
    ).rejects.toThrow(/swapEscrowFactory/)
    expect(getWithdrawalStore().list()).toHaveLength(0)
  })
})
