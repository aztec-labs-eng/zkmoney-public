/**
 * The bearer cash-out's bookkeeping. The burn itself is the sdk's and is covered on a sandbox; what
 * is web-specific is what the browser persists about it — a withdrawal record nobody signed in
 * owns, in the same store as the wallet's own, so the tracker finalizes it like any other.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { assignReads } from "../../../support/fakeReads"
import { testPage, testCore } from "../../../support/page"
import { formatUnits, parseUnits, type Address, type Hex } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { LIMIT, LIMIT_USD } from "../../../support/publicLimit"
import {
  sendLikeTheWallet,
  watchWalletDb,
  type WalletSendOptions,
} from "../../../support/submitBoundary"
import { operationRecord, testOperations } from "../../../support/operations"
import {
  createOwedClaims,
  fixed,
  memoryBackend,
  openDatabase,
  type OwedClaims,
} from "@obsidion/front-core"

const L2_TX = `0x${"0a".repeat(32)}` as Hex
const RECIPIENT = `0x${"dd".repeat(20)}` as Address
/** The escrow's whole balance; the burn takes all of it and the portal's fee comes out of it. */
const ESCROW = parseUnits("25", 18)
const SOURCE = { portal: `0x${"70".repeat(20)}`, l2Token: `0x${"11".repeat(32)}` }
/** The source executor's withdrawal fee. */
const FEE = parseUnits("0.1", 18)
/** The L1 client every burn's sdk options carry. */
const L1 = { l1: true }

vi.mock("../../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/env")>()),
  l1Transport: () => ({}),
}))
// The portal alone resolves no withdrawal wiring, so the record carries no deployment and the chain
// watcher is skipped — the assertions here are about what the burn writes, not about finalization.
vi.mock("../../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/oxideTuple")>()),
  l1PublicClient: () => L1,
}))
vi.mock("../../../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => FEE,
  withdrawalExecutor: async () => ({ fee: FEE }),
}))
const { claimSponsorRail } = vi.hoisted(() => ({
  claimSponsorRail: vi.fn(async () => ({ sponsor: { railId: 2 }, rail: { railId: 2 } })),
}))
vi.mock("../../../../src/features/registration/claimSponsorship", () => ({ claimSponsorRail }))

vi.mock("../../../../src/features/migration/historicTokenContext", () => ({
  findHistoricTuple: vi.fn(async () => null),
  historicTeeSigner: vi.fn(async () => ({ _id: "enclave" })),
}))

const fakeAuth = () => ({})

const PH = "f0".repeat(32)
const analytics = vi.hoisted(() => ({ enabled: true, firePaylinkEvent: vi.fn() }))
vi.mock("../../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/lib/analytics")>()),
  analyticsEnabled: () => analytics.enabled,
  firePaylinkEvent: analytics.firePaylinkEvent,
  paylinkPh: async () => PH,
}))

const SWAP_ESCROW = `0x${"ee".repeat(20)}` as Address
const COMMITMENT = `0x${"c0".repeat(32)}` as Hex
const { planSwapLeg, linkSecret } = vi.hoisted(() => ({
  planSwapLeg: vi.fn(async (_reads: unknown, _recoverer: unknown, receiveAsset: string) =>
    receiveAsset === "DAI"
      ? undefined
      : {
          output: receiveAsset,
          source: SOURCE,
          plan: {
            escrow: `0x${"ee".repeat(20)}`,
            escrowArgs: {
              nonce: `0x${"07".repeat(32)}`,
              recoveryCommitment: `0x${"c0".repeat(32)}`,
              relayerTip: 5n,
            },
            recovery: { account: `0x${"dd".repeat(20)}`, salt: { toString: () => "0x5a" } },
          },
        },
  ),
  linkSecret: { toString: () => "test-secret" },
}))
vi.mock("../../../../src/features/withdraw/withdrawGateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/withdraw/withdrawGateway")>()),
  planSwapLeg,
}))

const { exitPaylinkWithVoucher, paylinkVoucherUses, readPaylinkEscrowNote } = vi.hoisted(() => ({
  exitPaylinkWithVoucher: vi.fn(async (_args: Record<string, unknown>) => ({
    txHash: L2_TX,
    blockNumber: 42,
    amount: ESCROW,
    l1Recipient: RECIPIENT,
  })),
  paylinkVoucherUses: vi.fn(async () => 1),
  // The escrow note the burn spends; the link itself carries no amount.
  readPaylinkEscrowNote: vi.fn(async () => ({
    amount: ESCROW,
    tokenAddress: { toString: () => SOURCE.l2Token },
  })),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  decodePaylinkInline: (fragment: string) => ({
    secret: fragment === "fragment" ? linkSecret : { toString: () => fragment },
    paylinkType: "paylink_direct",
    classId: { toString: () => "0xclass" },
    chainId: 31337,
    rollupVersion: 1,
  }),
  exitPaylinkWithVoucher,
  paylinkVoucherUses,
  readPaylinkEscrowNote,
}))

const { cashOutLink } = await import("../../../../src/features/paylink/paylinkExit")
const { reportPaylinkClaims } = await import("../../../../src/features/paylink/paylinkClaimReport")
const { activeNamespace, closeSession, switchSession } = await import(
  "../../../../src/session/session"
)
const { openTestSession } = await import("../../../support/session")
const { pageSessionDeps } = await import("../../../../src/app/sessionDeps")
/** The flow's own owed claims, apart from the session's: the claim lands in what the deps carry. */
let claims: OwedClaims
beforeEach(() => {
  claims = createOwedClaims({ db: openDatabase(memoryBackend()) })
  const page = testPage(fakeAuth())
  assignReads(page.chain, {
    oxideTuple: async () => SOURCE,
    txAmountCap: async () => 5166n * 10n ** 18n,
    tokenImmutablesOf: async () => ({ symbol: "DAI", decimals: 18 }),
  })
  switchSession(activeNamespace(testCore().device), pageSessionDeps(page))
})
afterEach(closeSession)
const withdrawals = () => openTestSession().withdrawals
const clearWithdrawals = () =>
  Promise.all(
    withdrawals()
      .list.get()
      .records.map((r) => withdrawals().remove(r.localId)),
  )

const fakeWallet = () => ({
  networkId: "0xnet",
  node: { getTxReceipt: vi.fn(async () => ({ status: TxStatus.PENDING })) },
  pxe: {},
})
const deps = (compliant = true, wallet = fakeWallet()) =>
  ({
    rollupAddress: `0x${"ab".repeat(20)}`,
    session: Object.assign(Object.create(openTestSession()), {
      owedClaims: claims,
      wallet: fixed("wallet", wallet),
      contractService: fixed("contractService", {
        getContractAddress: async () => ({ toString: (): string => "0xtoken" }),
      }),
    }),
    screener: { screen: async () => ({ compliant, reason: { message: "Sanctioned address" } }) },
  } as unknown as Parameters<typeof cashOutLink>[0])

const claimedEvents = () =>
  analytics.firePaylinkEvent.mock.calls.filter(
    ([e]) => (e as { stage: string }).stage === "claimed",
  )

describe("cashOutLink", () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it("burns a swap cash-out to the planned escrow, with its escrow args for the sdk's broadcast", async () => {
    const quote = { relayerTip: 5n, amountOut: 24_500_000n, decimals: 6 as const }
    const record = await cashOutLink(deps(), "fragment", RECIPIENT, undefined, "USDC", quote)
    // A bearer has no account: recovery commits to the destination, salted from the link secret.
    expect(planSwapLeg).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      "USDC",
      RECIPIENT,
      ESCROW,
      quote,
      SOURCE,
    )
    // The bearer recovers with the link's secret, whatever the deployment.
    const [, recoverer] = vi.mocked(planSwapLeg).mock.calls[0] as unknown as [
      unknown,
      () => Promise<unknown>,
    ]
    await expect(recoverer()).resolves.toEqual({
      account: RECIPIENT,
      secret: linkSecret,
    })
    const args = exitPaylinkWithVoucher.mock.calls[0]![0] as {
      l1Recipient: { toString(): string }
      withdrawal: { tuple: unknown; l1: unknown; swap?: unknown }
    }
    expect(args.l1Recipient.toString().toLowerCase()).toBe(SWAP_ESCROW)
    expect(args.withdrawal).toEqual({
      tuple: SOURCE,
      l1: L1,
      swap: expect.objectContaining({
        escrowArgs: expect.objectContaining({ relayerTip: 5n }),
        recovery: expect.objectContaining({ account: RECIPIENT }),
      }),
    })
    expect(record).toMatchObject({
      recipient: RECIPIENT,
      swapOutput: "USDC",
      swapEscrow: SWAP_ESCROW,
      swapRecoveryCommitment: COMMITMENT,
      swapEstimatedOut: "24500000",
    })
  })

  it("records the burn as a paylink cash-out, with what the recipient is left with", async () => {
    const record = await cashOutLink(deps(), "fragment", RECIPIENT)

    expect(record.phase).toBe("l2_mined")
    expect(record.recipient).toBe(RECIPIENT)
    // Labelled like the account holder's own paylink burn, so the feed, the detail sheet and the
    // notifications say "paylink" for both.
    expect(record.source).toBe("paylink")
    expect(record.recipientProvenance).toBe("saved-recipient")
    // The escrow the burn spent — how the link page finds this record again.
    expect(record.paylinkId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(record.l2TxHash).toBe(L2_TX)
    // Gross is the escrow; the display amount is what lands once the executor's fee and the relayer
    // tip come out.
    expect(record.rawAmount).toBe(ESCROW.toString())
    expect(record.relayerTip).toBe(WITHDRAW_RELAYER_TIP.toString())
    expect(record.withdrawalFee).toBe(FEE.toString())
    expect(record.amount).toBe(formatUnits(ESCROW - FEE - WITHDRAW_RELAYER_TIP, 18))
  })

  it("burns through the voucher rail with the link's escrow as the only identity", async () => {
    await cashOutLink(deps(), "fragment", RECIPIENT)

    expect(claimSponsorRail).toHaveBeenCalledWith(expect.anything(), "voucher", { tuple: SOURCE })
    const args = exitPaylinkWithVoucher.mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(args.sponsor).toEqual({ railId: 2 })
    expect(args.signer).toEqual({ _id: "enclave" })
    expect((args.l1Recipient as { toString(): string }).toString()).toBe(RECIPIENT)
  })

  it("refuses a blocked recipient before anything is burned or written", async () => {
    await expect(cashOutLink(deps(false), "fragment", RECIPIENT)).rejects.toThrow(
      /Sanctioned address/,
    )

    expect(exitPaylinkWithVoucher).not.toHaveBeenCalled()
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      0,
    )
  })

  // The burn spends the whole escrow, so a link over the limit has no smaller amount to send.
  it(`cashes out a link of exactly ${LIMIT_USD} and refuses one atomic unit more before burning or writing`, async () => {
    const LIMIT_ATOMIC = parseUnits(String(LIMIT), 18)
    const note = (amount: bigint) => ({ amount, tokenAddress: { toString: () => SOURCE.l2Token } })
    try {
      readPaylinkEscrowNote.mockResolvedValue(note(LIMIT_ATOMIC))
      await cashOutLink(deps(), "fragment-at-limit", RECIPIENT)
      expect(exitPaylinkWithVoucher).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(claimedEvents()).toHaveLength(1))
      await clearWithdrawals()

      readPaylinkEscrowNote.mockResolvedValue(note(LIMIT_ATOMIC + 1n))
      await expect(cashOutLink(deps(), "fragment-over-limit", RECIPIENT)).rejects.toThrow(
        `This link holds more than the ${LIMIT_USD} withdrawal limit, so it cannot be claimed to an Ethereum wallet.`,
      )
      expect(exitPaylinkWithVoucher).toHaveBeenCalledTimes(1)
      expect(
        [...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime),
      ).toHaveLength(0)
      expect(
        testOperations()
          .view.get()
          .records.filter((op) => op.state === "local"),
      ).toHaveLength(0)
      // Nothing was owed for the refused link.
      await reportPaylinkClaims(
        [...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime),
        claims,
      )
      expect(claimedEvents()).toHaveLength(1)
    } finally {
      readPaylinkEscrowNote.mockResolvedValue(note(ESCROW))
    }
  })

  it("preserves a broadcast hash when waiting for its receipt fails", async () => {
    exitPaylinkWithVoucher.mockImplementationOnce(async (args) => {
      await sendLikeTheWallet(args as WalletSendOptions, L2_TX, () => {})
      throw new Error("Receipt timed out")
    })
    const record = await cashOutLink(deps(), "fragment", RECIPIENT)
    expect(record.phase).toBe("submitting")
    expect(record.l2TxHash).toBe(L2_TX)
    expect(record.failure).toBeUndefined()
    const op = operationRecord(record.operationId!)
    expect(op).toMatchObject({ state: "sent", txHash: L2_TX, flow: "paylink-claim-l1" })
    expect(testOperations().live.get().has(record.operationId!)).toBe(false)
  })

  it("saves the burn's hash before the node takes it, and sends nothing when it cannot", async () => {
    const db = watchWalletDb()
    let heldAtNode: boolean | undefined
    exitPaylinkWithVoucher.mockImplementationOnce(async (args) => {
      await sendLikeTheWallet(args as WalletSendOptions, L2_TX, () => {
        heldAtNode = db.holds("withdrawals", L2_TX)
      })
      return { txHash: L2_TX, blockNumber: 42, amount: ESCROW, l1Recipient: RECIPIENT }
    })
    await cashOutLink(deps(), "fragment-2", RECIPIENT)
    expect(heldAtNode).toBe(true)

    db.refuse("withdrawals", L2_TX)
    const node = vi.fn()
    exitPaylinkWithVoucher.mockImplementationOnce(async (args) => {
      await sendLikeTheWallet(args as WalletSendOptions, L2_TX, node)
      return { txHash: L2_TX, blockNumber: 42, amount: ESCROW, l1Recipient: RECIPIENT }
    })
    await expect(cashOutLink(deps(), "fragment", RECIPIENT)).rejects.toThrow("quota exceeded")
    expect(node).not.toHaveBeenCalled()
  })

  it("makes a rejected broadcast retryable instead of returning a pending withdrawal", async () => {
    exitPaylinkWithVoucher.mockImplementationOnce(async (args) => {
      await sendLikeTheWallet(args as WalletSendOptions, L2_TX, () => {})
      throw new Error("Node rejected withdrawal")
    })
    const wallet = fakeWallet()
    wallet.node.getTxReceipt.mockResolvedValue({ status: TxStatus.DROPPED })
    await expect(cashOutLink(deps(true, wallet), "fragment", RECIPIENT)).rejects.toThrow(
      /Node rejected/,
    )
    expect(
      [...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)[0]?.phase,
    ).toBe("failed")
  })
})

describe("cashOutLink claim reporting", () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.clearAllMocks()
    analytics.enabled = true
  })

  it("reports the spent escrow as one claimed link, with no address, amount or hash", async () => {
    await cashOutLink(deps(), "fragment", RECIPIENT)
    await vi.waitFor(() => expect(claimedEvents()).toHaveLength(1))
    expect(claimedEvents()[0]).toEqual([
      { stage: "claimed", flavor: "direct", amount_bucket: "<50", paylink_ph: PH },
    ])
    const wire = JSON.stringify(analytics.firePaylinkEvent.mock.calls).toLowerCase()
    expect(wire).not.toContain("dd".repeat(20))
    expect(wire).not.toContain("0a".repeat(32))
    expect(wire).not.toContain(ESCROW.toString())
    // The withdrawals view reporting again finds nothing owed.
    await reportPaylinkClaims(
      [...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime),
      claims,
    )
    expect(claimedEvents()).toHaveLength(1)
  })

  it("reports nothing from a browser without analytics consent", async () => {
    analytics.enabled = false
    await cashOutLink(deps(), "fragment", RECIPIENT)
    analytics.enabled = true
    await reportPaylinkClaims(
      [...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime),
      claims,
    )
    expect(claimedEvents()).toHaveLength(0)
  })
})
