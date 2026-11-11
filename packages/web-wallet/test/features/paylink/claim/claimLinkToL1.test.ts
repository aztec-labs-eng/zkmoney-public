/**
 * What the paylink L1 claim hands to the burn and persists. The swap route mirrors a balance
 * withdrawal: the burn pays the planned escrow, the sdk pairs its swap with the release in the same
 * tx, and the record carries the escrow args plus the confirm-time quote the detail sheet renders.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { assignReads } from "../../../support/fakeReads"
import { testPage, testCore } from "../../../support/page"
import { formatUnits, parseUnits, type Address, type Hex } from "viem"
import { DEFAULT_CONTRACTS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { LIMIT, LIMIT_USD } from "../../../support/publicLimit"
import {
  sendLikeTheWallet,
  watchWalletDb,
  type WalletSendOptions,
} from "../../../support/submitBoundary"
import { operationRecord, testOperations } from "../../../support/operations"

const RELAYER_TIP = 5n * 10n ** 18n
const SWAP_COMMIT = { relayerTip: RELAYER_TIP, amountOut: 1n, decimals: 18 }
const L2_TX = `0x${"0a".repeat(32)}` as Hex
const RECIPIENT = `0x${"dd".repeat(20)}` as Address
// The claimer's Oxide account, as the stubbed account factory predicts it.
const ACCOUNT = `0x${"ac".repeat(20)}` as Address
const TX_AMOUNT_CAP = 5166n * 10n ** 18n
/** The source executor's withdrawal fee. */
const FEE = parseUnits("0.1", 18)
const SWAP_TUPLE = {
  l2Token: `0x${"11".repeat(32)}`,
  swapEscrowFactoryV2: `0x${"fa".repeat(20)}`,
  accountFactory: `0x${"af".repeat(20)}`,
  portal: `0x${"70".repeat(20)}`,
  token: `0x${"da".repeat(20)}`,
  // Leading byte below the BN254 modulus — AztecAddress rejects anything at or above the field.
  l2Broadcaster: `0x${"1b".repeat(32)}`,
}

// Each fragment is its own link.
const link = (fragment = "0xsecret") => ({
  paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
  secret: { toString: () => fragment, toBuffer: () => new Uint8Array(32) },
  classId: { toString: () => "0x1234" },
  chainId: 31337,
  rollupVersion: 1,
})
/** A create's link as the sdk prepares it. */
const prepared = {
  paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
  secret: Fr.random(),
  fallbackSecret: Fr.random(),
  fallbackKeyHash: Fr.random(),
  classId: Fr.ZERO,
  chainId: 31337,
  rollupVersion: 1,
}
// The escrow note the burn spends; the link itself carries no amount.
let escrowAmount = parseUnits("120", 18)

vi.mock("../../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/env")>()),
  l1Transport: () => ({}),
}))
// The portal alone resolves no withdrawal wiring, so the chain watcher is skipped; swap tests
// override the tuple. A swap asks the account factory for the claimer's account, which recovers
// the escrow.
const PORTAL_ONLY = { portal: `0x${"70".repeat(20)}`, l2Token: SWAP_TUPLE.l2Token }
const mockTuple = vi.fn<() => Record<string, string>>(() => ({ ...PORTAL_ONLY }))
vi.mock("../../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/oxideTuple")>()),
  l1PublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "predictAccountAddress" ? ACCOUNT : undefined,
  }),
}))
vi.mock("../../../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => FEE,
  withdrawalExecutor: async () => ({ fee: FEE }),
}))
vi.mock("../../../../src/features/registration/claimSponsorship", () => ({
  claimSponsorContext: async () => ({ fpcAddress: {}, policy: {} }),
  noteSubscribed: vi.fn(),
}))
vi.mock("../../../../src/features/migration/historicTokenContext", () => ({
  findHistoricTuple: vi.fn(),
  historicSponsorTargets: vi.fn(),
  historicTokenContext: vi.fn(),
}))
const fakeAuth = () => ({
  getSecretKey: async () => ({ toString: () => `0x${"07".repeat(32)}` }),
})
const firePaylinkEvent = vi.hoisted(() => vi.fn())
vi.mock("../../../../src/lib/analytics", () => ({
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
// The link's other sends, as the boundary tests below drive them.
const sends = {
  createSponsoredPaylink: vi.fn(),
  claimSponsoredPaylink: vi.fn(),
  refundSponsoredPaylink: vi.fn(),
}
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  PaylinkService: class {
    claimSponsoredPaylinkToL1 = claimToL1
    createSponsoredPaylink = sends.createSponsoredPaylink
    claimSponsoredPaylink = sends.claimSponsoredPaylink
    refundSponsoredPaylink = sends.refundSponsoredPaylink
  },
  decodePaylinkInline: (fragment: string) => link(fragment),
  readPaylinkEscrowNote: async () => ({
    amount: escrowAmount,
    tokenAddress: { toString: () => SWAP_TUPLE.l2Token },
  }),
}))

const recordBurnDuration = vi.hoisted(() => vi.fn(async (_durations: unknown, _ms: number) => {}))
vi.mock("../../../../src/features/withdraw/burnTiming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/withdraw/burnTiming")>()),
  recordBurnDuration,
}))

const { claimLinkToL1, claimSponsoredLink, createSponsoredLink, recoverSponsoredLink } =
  await import("../../../../src/features/paylink/sponsoredPaylink")
const { TxInFlightError, fixed } = await import("@obsidion/front-core")
const { activeNamespace, closeSession, switchSession } = await import("../../../../src/session/session")
const { openTestSession } = await import("../../../support/session")
const { pageSessionDeps } = await import("../../../../src/app/sessionDeps")
beforeEach(() => {
  const page = testPage(fakeAuth())
  assignReads(page.chain, {
    oxideTuple: async () => mockTuple(),
    txAmountCap: async () => TX_AMOUNT_CAP,
  })
  void switchSession(activeNamespace(testCore().device), pageSessionDeps(page))
})
afterEach(closeSession)
const withdrawals = () => openTestSession().withdrawals
const clearWithdrawals = () =>
  Promise.all(
    withdrawals()
      .list.get()
      .records.map((r) => withdrawals().remove(r.localId)),
  )

const deps = (node: object = { getContract: async () => ({}) }) =>
  ({
    rollupAddress: {},
    // The session's stores, with the flow's own burn timing and its fakes.
    session: Object.assign(Object.create(openTestSession()), {
      burnDurations: BURNS,
      wallet: fixed("wallet", { networkId: "0xnet", node, pxe: {} }),
      account: fixed("account", { getAddress: () => ({ toString: (): string => "0xuser" }) }),
      contractService: fixed("contractService", {}),
      token: fixed("token", {
        fetchTokenInformation: async () => ({ symbol: "DAI", decimals: 18 }),
      }),
      teeSigner: fixed("teeSigner", {}),
    }),
  } as unknown as Parameters<typeof claimLinkToL1>[0])
/** The flow's own burn timing, apart from the session's. */
const BURNS = { add: async () => {}, samples: async () => [] }
const screener = { screen: async () => ({ compliant: true }) } as never

const burnArgs = () => {
  const [, recipient, opts] = claimToL1.mock.calls[0]! as unknown as [
    unknown,
    { toString(): string },
    { proverTip: bigint; withdrawal: { tuple: unknown; l1: unknown; swap?: unknown } },
  ]
  return { recipient: recipient.toString().toLowerCase(), opts }
}

const { upsertSavedL1WalletContact: saved } = await import("@obsidion/front-core")

describe("claimLinkToL1's saved recipient", () => {
  beforeEach(() => vi.mocked(saved).mockClear())

  it("goes to the book the deps carry, and nowhere for a visitor", async () => {
    const contacts = { upsertL1WalletContact: vi.fn() }
    const d = deps()
    const session = Object.assign(Object.create(d.session), { contacts })
    await claimLinkToL1({ ...d, session }, "frag-direct", RECIPIENT, screener, vi.fn())
    await vi.waitFor(() =>
      expect(saved).toHaveBeenCalledWith(contacts, expect.objectContaining({ address: RECIPIENT })),
    )
    vi.mocked(saved).mockClear()
    await claimLinkToL1(deps(), "frag-visitor", RECIPIENT, screener, vi.fn())
    expect(saved).not.toHaveBeenCalled()
  })
})

describe("claimLinkToL1", () => {
  beforeEach(async () => {
    localStorage.clear()
    mockTuple.mockReturnValue({ ...PORTAL_ONLY })
    escrowAmount = parseUnits("120", 18)
    claimToL1.mockClear()
    recordBurnDuration.mockClear()
    firePaylinkEvent.mockClear()
  })

  it("burns straight to the recipient with no swap fields on the direct route", async () => {
    const record = await claimLinkToL1(deps(), "frag-direct", RECIPIENT, screener, vi.fn())

    expect(record.source).toBe("paylink")
    expect(record.phase).toBe("l2_mined")
    expect(record.swapOutput).toBeUndefined()
    expect(record.swapEscrow).toBeUndefined()
    // The fees are on the record, and the display amount is net of them.
    expect(record.relayerTip).toBe(WITHDRAW_RELAYER_TIP.toString())
    expect(record.withdrawalFee).toBe(FEE.toString())
    expect(record.proverTip).toBeUndefined()
    expect(record.amount).toBe(formatUnits(escrowAmount - FEE - WITHDRAW_RELAYER_TIP, 18))
    const { recipient, opts } = burnArgs()
    expect(recipient).toBe(RECIPIENT.toLowerCase())
    // The sdk builds the release broadcast and the meta; the flow passes where the burn settles.
    expect(opts).toEqual({
      proverTip: 0n,
      withdrawal: { tuple: PORTAL_ONLY, l1: expect.anything() },
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
    expect(record.amount).toBe(formatUnits(escrowAmount - FEE - WITHDRAW_RELAYER_TIP - tip, 18))
    expect(recordBurnDuration).toHaveBeenCalledTimes(1)
    expect(recordBurnDuration.mock.calls[0]![0]).toBe(BURNS)
    expect(recordBurnDuration.mock.calls[0]![1]).toBeGreaterThanOrEqual(0)
  })

  it("refuses a link the fee and the tip would consume, before any record exists", async () => {
    const tip = parseUnits("0.5", 18)
    escrowAmount = FEE + WITHDRAW_RELAYER_TIP + tip
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
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      0,
    )
    expect(claimToL1).not.toHaveBeenCalled()
  })

  // The burn spends the whole escrow, so a link over the limit has no smaller amount to send.
  it(`claims a link of exactly ${LIMIT_USD} and refuses one atomic unit more before screening or recording`, async () => {
    escrowAmount = parseUnits(String(LIMIT), 18)
    await claimLinkToL1(deps(), "frag-at-limit", RECIPIENT, screener, vi.fn())
    expect(claimToL1).toHaveBeenCalledTimes(1)
    await clearWithdrawals()

    escrowAmount = parseUnits(String(LIMIT), 18) + 1n
    const screen = vi.fn(async () => ({ compliant: true }))
    const run = claimLinkToL1(deps(), "frag-over-limit", RECIPIENT, { screen } as never, vi.fn())
    await expect(run).rejects.toThrow(
      `This link holds more than the ${LIMIT_USD} withdrawal limit, so it cannot be claimed to an Ethereum wallet.`,
    )
    expect(screen).not.toHaveBeenCalled()
    expect(claimToL1).toHaveBeenCalledTimes(1)
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      0,
    )
    expect(
      testOperations()
        .view.get()
        .records.filter((op) => op.state === "local"),
    ).toHaveLength(0)
  })

  it("leaves a burn that reached the node to the chain, record and operation both", async () => {
    claimToL1.mockImplementationOnce(async (...args: unknown[]) => {
      await sendLikeTheWallet(args[4] as WalletSendOptions, L2_TX, () => {})
      throw new Error("Receipt timed out")
    })
    const d = deps({ getTxReceipt: vi.fn(async () => ({ status: TxStatus.PENDING })) })
    const record = await claimLinkToL1(d, "frag-direct", RECIPIENT, screener, vi.fn())
    expect(record).toMatchObject({ phase: "submitting", l2TxHash: L2_TX })
    expect(record.failure).toBeUndefined()
    expect(operationRecord(record.operationId!)).toMatchObject({
      state: "sent",
      txHash: L2_TX,
    })
    // Only a burn this flow saw mine has a confirm-to-mined time.
    expect(recordBurnDuration).not.toHaveBeenCalled()
  })

  it("puts back to pending an earlier withdrawal the node still holds, and keeps no refused burn", async () => {
    const EARLIER = `0x${"0e".repeat(32)}` as Hex
    await withdrawals().create({
      networkId: "0xnet",
      localId: "earlier",
      l2TxHash: EARLIER,
      recipient: RECIPIENT,
      recipientProvenance: "saved-recipient",
      amount: "1",
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      phase: "failed",
      failure: { code: "withdrawal.dropped" },
      startTime: 1,
      endTime: 2,
    })
    claimToL1.mockImplementationOnce(async (...args: unknown[]) => {
      await sendLikeTheWallet(args[4] as WalletSendOptions, L2_TX, () => {})
      throw new Error(
        `Nullifier conflict with existing tx ${EARLIER}. Minimum required fee: 1, got: 0`,
      )
    })
    await expect(
      claimLinkToL1(deps(), "frag-direct", RECIPIENT, screener, vi.fn()),
    ).rejects.toThrow("An earlier withdrawal of these funds is still pending.")
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      1,
    )
    const earlier = await withdrawals().get("earlier")
    expect(earlier).toMatchObject({ phase: "submitting", l2TxHash: EARLIER })
    expect(earlier?.failure).toBeUndefined()
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
      l1: expect.anything(),
      swap: expect.objectContaining({
        escrowArgs: expect.objectContaining({ relayerTip: RELAYER_TIP }),
        recovery: expect.objectContaining({ account: ACCOUNT }),
      }),
    })

    const stored = await withdrawals().get(record.localId)
    expect(stored?.swapOutput).toBe("USDC")
    expect(stored?.swapNonce).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(stored?.swapRecoveryCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(stored?.swapRelayerTip).toBe(RELAYER_TIP.toString())
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
      factory: SWAP_TUPLE.swapEscrowFactoryV2,
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
      l1: expect.anything(),
      swap: expect.objectContaining({
        escrowArgs: expect.objectContaining({ relayerTip: RELAYER_TIP }),
      }),
    })
    expect(record.swapEscrow).toBe(escrow)
    expect(record.swapOutput).toBe("USDC")
  })

  it("refuses a link that leaves the escrow nothing to swap, before any record exists", async () => {
    mockTuple.mockReturnValue(SWAP_TUPLE)
    escrowAmount = FEE + WITHDRAW_RELAYER_TIP + RELAYER_TIP
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
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      0,
    )
    expect(claimToL1).not.toHaveBeenCalled()
  })

  it("plans the escrow net of the prover tip the burn carries", async () => {
    mockTuple.mockReturnValue(SWAP_TUPLE)
    const tip = parseUnits("0.5", 18)
    // Enough for the swap without the tip; the tip leaves the escrow nothing.
    escrowAmount = FEE + WITHDRAW_RELAYER_TIP + RELAYER_TIP + tip
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
})

// Every send of a link saves its hash before the node takes it; one it cannot save is never sent.
describe("a link's submit boundary", () => {
  const node = {
    getBlockData: async () => ({ header: { globalVariables: { timestamp: 1000n } } }),
    getTxReceipt: vi.fn(async () => ({ status: TxStatus.PENDING })),
  }
  const run = (send: () => Promise<unknown>) => send().catch((e: unknown) => e)
  const flows = [
    {
      name: "a create",
      key: "operations",
      sdk: sends.createSponsoredPaylink,
      at: 2,
      prepared,
      result: L2_TX,
      send: () => createSponsoredLink(on(), "25"),
    },
    {
      name: "a claim",
      key: "operations",
      sdk: sends.claimSponsoredPaylink,
      at: 2,
      result: L2_TX,
      send: () => claimSponsoredLink(on(), "frag"),
    },
    {
      name: "a recovery",
      key: "operations",
      sdk: sends.refundSponsoredPaylink,
      at: 2,
      result: L2_TX,
      send: () => recoverSponsoredLink(on(), "frag"),
    },
    {
      name: "a claim to Ethereum",
      key: "withdrawals",
      sdk: claimToL1,
      at: 4,
      result: { txHash: L2_TX, blockNumber: 42 },
      send: () => claimLinkToL1(on(), "frag-direct", RECIPIENT, screener, vi.fn()),
    },
  ]
  function on() {
    return deps(node)
  }

  beforeEach(() => localStorage.clear())

  it.each(flows)("$name holds its hash when the node takes it", async (flow) => {
    const { key, sdk, at, result, send } = flow
    const db = watchWalletDb()
    let heldAtNode: boolean | undefined
    sdk.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[at] as WalletSendOptions
      const prepared = "prepared" in flow ? flow.prepared : undefined
      await sendLikeTheWallet(options, L2_TX, () => (heldAtNode = db.holds(key, L2_TX)), prepared)
      return result as never
    })
    await run(send)
    expect(heldAtNode).toBe(true)
  })

  it.each(flows)("$name that cannot save its hash is not sent", async (flow) => {
    const { key, sdk, at, result, send } = flow
    watchWalletDb().refuse(key, L2_TX)
    const sent = vi.fn()
    sdk.mockImplementationOnce(async (...args: unknown[]) => {
      const prepared = "prepared" in flow ? flow.prepared : undefined
      await sendLikeTheWallet(args[at] as WalletSendOptions, L2_TX, sent, prepared)
      return result as never
    })
    const err = await run(send)
    expect(sent).not.toHaveBeenCalled()
    expect(err).toMatchObject({ message: "quota exceeded" })
    expect(err).not.toBeInstanceOf(TxInFlightError)
  })
})
