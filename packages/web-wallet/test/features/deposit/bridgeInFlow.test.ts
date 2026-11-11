// @vitest-environment node
/**
 * Bridging in over a fake provider, wallet client and origin chain: the review quotes without the
 * wallet, and Bridge in signs the provider's approvals and then its bridge call, saved first as a
 * `signing` record and then by its hash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import {
  admitDeposit,
  createBridgeIns,
  createContacts,
  memoryBackend,
  memoryStore,
  NOMINAL_USD_VALUATION,
  openDatabase,
  type BridgeInQuote,
  type BridgeInQuoteRequest,
  type BridgeIns,
} from "@obsidion/front-core"
import type { L1WalletView } from "../../../src/session/l1Wallet"
import {
  openBridgeInFlow,
  type BridgeInSend,
} from "../../../src/features/deposit/BridgeInModal/bridgeInFlow"
import {
  bridgeInStart,
  bridgeQuoteKey,
} from "../../../src/features/deposit/BridgeInModal/bridgeInTransition"
import { bridgeInFees, selectQuote } from "../../../src/features/deposit/bridgeInQuoteView"
import { bridgeSize } from "../../../src/features/deposit/bridgeChains"
import { testQuery } from "../../support/query"

const ACCOUNT = `0x${"a1".repeat(20)}` as Address
const FRESH = `0x${"f0".repeat(20)}` as Address
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address
const L1_DAI = `0x${"da".repeat(20)}` as Address
const L1_USDC = `0x${"c1".repeat(20)}` as Address
const SPOKE_POOL = `0x${"b5".repeat(20)}` as Address
const APPROVE = `0x${"01".repeat(32)}` as Hex
const DEPOSIT = `0x${"02".repeat(32)}` as Hex

/** Across's shape: 0.5 USDC of fee, the rest lands as USDC. */
const priced = async (request: BridgeInQuoteRequest): Promise<BridgeInQuote> => {
  const input = request.inputAmount ?? request.outputAmount! + 500_000n
  const output = request.outputAmount ?? input - 500_000n
  return {
    inputAmount: input,
    maxInputAmount: input,
    outputAmount: output,
    expectedOutputAmount: output,
    fee: 500_000n,
    fillSeconds: 10,
    expiresAt: 60_000,
    txs: [
      { chainId: 8453, to: BASE_USDC, data: "0xa0" as Hex },
      { chainId: 8453, to: SPOKE_POOL, data: "0xb0" as Hex },
    ],
  }
}

const request = (amount: { inputAmount: bigint } | { outputAmount: bigint }) =>
  ({
    originChainId: 8453,
    inputToken: BASE_USDC,
    destinationChainId: 1,
    outputToken: L1_USDC,
    outputSymbol: "USDC",
    depositor: ACCOUNT,
    recipient: ACCOUNT,
    ...amount,
  } as BridgeInQuoteRequest)

/** The portal's answer for a quote: at most 25 USDC is credited per deposit. */
const admit = (quote: BridgeInQuote) =>
  admitDeposit(
    {
      token: { symbol: "USDC", decimals: 6, settlesIn: L1_USDC, swapped: false },
      depositFeeAtomic: 400_000n,
      minimumAtomic: 1_000_000n,
      txAmountCap: 25_000_000n,
    },
    {
      landedAtomic: quote.expectedOutputAmount,
      gross: { atomic: quote.inputAmount, decimals: 6, valuation: NOMINAL_USD_VALUATION },
    },
  )
const DEPOSIT_FEE = { shown: "0.4", row: L1_DAI }

let provider: ReturnType<typeof vi.fn<(r: BridgeInQuoteRequest) => Promise<BridgeInQuote>>>
let sent: { to: string; data: string }[]
let approval: "success" | "reverted"
let waited: string[]
let sendError: unknown

function world({ markSent }: { markSent?: BridgeIns["markSent"] } = {}) {
  const db = openDatabase(memoryBackend())
  const store = createBridgeIns({ db })
  const bridgeIns = { ...store, markSent: markSent ?? store.markSent }
  const contacts = createContacts({ db, now: () => 1 })
  const view = memoryStore<L1WalletView>({
    account: ACCOUNT,
    accounts: [ACCOUNT],
    chainId: 8453,
    walletName: "Rabby",
    connecting: false,
    reopening: false,
  })
  const quote = testQuery()<[BridgeInQuoteRequest], BridgeInQuote>("bridgeInQuote", {
    load: (r) => provider(r),
    stale: 0,
  })
  const report = vi.fn()
  const onSent = vi.fn()
  const track = vi.fn()
  const clients = vi.fn(async () => ({
    account: ACCOUNT,
    chain: { id: 8453 } as never,
    walletClient: {
      sendTransaction: async (tx: { to: string; data: string }) => {
        if (sendError && sent.length > 0) throw sendError
        sent.push(tx)
        return sent.length === 1 ? APPROVE : DEPOSIT
      },
    } as never,
  }))
  const flow = openBridgeInFlow(
    {
      l1Wallet: { view: view.readonly, clients },
      quote,
      depositFee: async () => "0.4",
      reader: () => ({
        waitForTransactionReceipt: (async ({ hash }: { hash: Hex }) => {
          waited.push(hash)
          return { status: approval }
        }) as never,
        getTransactionCount: (async () => 7) as never,
      }),
      bridgeIns,
      contacts,
      track,
      now: () => 1_000,
      initial: bridgeInStart(undefined, { chain: 8453, token: "USDC" }),
      report,
    },
    () => ({ onSent }),
  )
  const sheet = new AbortController()
  flow.start(sheet.signal)
  const saved = async () => (await store.all())[0]
  return { flow, store, contacts, view, report, onSent, track, saved, clients }
}

type World = ReturnType<typeof world>

/** Reviews `r` as the lookup reads it, then sends the review. */
async function reviewAndSend(
  { flow }: World,
  r: BridgeInQuoteRequest,
  more: Partial<BridgeInSend> = {},
) {
  await flow.quote(r).read()
  await flow.review({ request: r, fresh: false, fixed: !!more.fixed })
  const shown = selectQuote(flow.state.get(), bridgeQuoteKey(r))!.answer!
  await flow.send({
    key: bridgeQuoteKey(r),
    reviewed: shown,
    request: r,
    fixed: false,
    recipient: async () => FRESH,
    units: { symbol: "USDC", inputDecimals: 6, outputSymbol: "USDC", outputDecimals: 6 },
    feeUsd: () => "0.5",
    walletName: "Rabby",
    admit,
    depositFee: DEPOSIT_FEE,
    ...more,
  })
}

beforeEach(() => {
  provider = vi.fn(priced)
  sent = []
  approval = "success"
  waited = []
  sendError = undefined
})
afterEach(() => vi.restoreAllMocks())

describe("bridgeSize", () => {
  it("asks for no quote until the origin token's decimals are read", () => {
    const size = { amount: "20", side: "from" as const, maxed: false, outDecimals: 6 }
    expect(bridgeSize(size).request).toBeUndefined()
    expect(bridgeSize({ ...size, inDecimals: 6 }).request).toEqual({ inputAmount: 20_000_000n })
  })
})

describe("To typed on a route that swaps on the origin chain", () => {
  const BASE_DAI = `0x${"d1".repeat(20)}` as Address
  const swapRequest = (amount: { inputAmount: bigint } | { outputAmount: bigint }) =>
    ({ ...request(amount), inputToken: BASE_DAI } as BridgeInQuoteRequest)
  const sized = (w: World, amount: string) =>
    bridgeSize({
      amount,
      side: "to",
      maxed: false,
      inDecimals: 6,
      outDecimals: 6,
      needed: (a) => a,
      originSwap: true,
      rate: w.flow.state.get().rate?.quote,
    }).request

  it("quotes exact input at the last quote's rate", async () => {
    const w = world()
    await w.flow.quote(swapRequest({ inputAmount: 20_500_000n })).read()
    w.flow.type("to", "30")
    // 20.5 sent lands 20 at 0.5 of fee: 30 lands from 30.5.
    expect(sized(w, "30")).toEqual({ inputAmount: 30_500_000n })
    await w.flow.quote(swapRequest({ inputAmount: 30_500_000n })).read()
    expect(provider).toHaveBeenLastCalledWith(expect.objectContaining({ inputAmount: 30_500_000n }))
    expect(provider).not.toHaveBeenCalledWith(
      expect.objectContaining({ outputAmount: expect.anything() }),
    )
  })

  it("reads its rate from the first quote when none is held, and keeps it while To stays", async () => {
    const w = world()
    w.flow.type("to", "30")
    const first = sized(w, "30")
    expect(first).toEqual({ inputAmount: 1_000_000n })
    await w.flow.quote(swapRequest(first!)).read()
    const converted = sized(w, "30")
    expect(converted).toEqual({ inputAmount: 30_500_000n })
    await w.flow.quote(swapRequest(converted!)).read()
    expect(sized(w, "30")).toEqual(converted)
  })
})

describe("bridging in", () => {
  it("signs the approvals first, then the bridge call, saved with its hash and followed", async () => {
    const w = world()
    await reviewAndSend(w, request({ inputAmount: 20_000_000n }))
    expect(sent.map((tx) => tx.data)).toEqual(["0xa0", "0xb0"])
    // Only the approval's receipt is waited on.
    expect(waited).toEqual([APPROVE])
    expect(provider).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputAmount: 20_000_000n, recipient: FRESH, depositor: ACCOUNT }),
    )
    expect(await w.saved()).toMatchObject({
      status: "pending",
      originTxHash: DEPOSIT,
      recipient: FRESH,
      inputAmount: "20000000",
      call: { to: SPOKE_POOL, data: "0xb0" },
      nonceHint: 7,
    })
    expect(w.onSent).toHaveBeenCalledWith(DEPOSIT)
    expect(w.track).toHaveBeenCalledOnce()
    expect(w.flow.state.get()).toMatchObject({ step: "status", sending: false })
    // The origin wallet joins the saved wallets.
    await vi.waitFor(async () =>
      expect(await w.contacts.all()).toMatchObject([
        { address: ACCOUNT, l1Wallet: { provenance: "deposit-attested" } },
      ]),
    )
  })

  it("reviews without the wallet: every quote is priced to the wallet itself", async () => {
    const w = world()
    const r = request({ inputAmount: 20_000_000n })
    await w.flow.quote(r).read()
    await w.flow.review({ request: r, fresh: false, fixed: false })
    expect(w.flow.state.get().step).toBe("progress")
    expect(sent).toEqual([])
    for (const [asked] of provider.mock.calls) expect(asked).toMatchObject({ recipient: ACCOUNT })
  })

  it("stays on the amount when a typed To's fresh quote costs more than the balance", async () => {
    const w = world()
    const r = request({ outputAmount: 100_000_000n })
    await w.flow.review({ request: r, fresh: true, balance: 50_000_000n, fixed: false })
    expect(w.flow.state.get().step).toBe("amount")
    expect(selectQuote(w.flow.state.get(), bridgeQuoteKey(r))?.answer?.inputAmount).toBe(
      100_500_000n,
    )
  })

  it("stays on the amount with the refusal when a typed To's fresh quote fails", async () => {
    const w = world()
    provider.mockRejectedValueOnce(new Error("quote down"))
    const r = request({ outputAmount: 100_000_000n })
    await w.flow.review({ request: r, fresh: true, fixed: false })
    expect(w.flow.state.get().step).toBe("amount")
    expect(selectQuote(w.flow.state.get(), bridgeQuoteKey(r))?.refusal).toEqual({
      code: "bridge.quoteFailed",
    })
  })

  it("goes back to the review, sending nothing, when the bridge price drops, and sends the new one next", async () => {
    const w = world()
    const r = request({ inputAmount: 20_000_000n })
    provider.mockImplementationOnce(priced).mockImplementationOnce(async (asked) => {
      const fresh = await priced(asked)
      return { ...fresh, outputAmount: fresh.outputAmount - 1_000_000n }
    })
    await reviewAndSend(w, r)
    expect(sent).toEqual([])
    expect(w.flow.state.get().repriced).toBe(true)
    const repriced = selectQuote(w.flow.state.get(), bridgeQuoteKey(r))!.answer!
    expect(repriced.outputAmount).toBe(18_500_000n)

    provider.mockImplementation(async (asked) => ({
      ...(await priced(asked)),
      outputAmount: 18_500_000n,
    }))
    await w.flow.send({
      key: bridgeQuoteKey(r),
      reviewed: repriced,
      request: r,
      fixed: false,
      recipient: async () => FRESH,
      units: { symbol: "USDC", inputDecimals: 6, outputSymbol: "USDC", outputDecimals: 6 },
      feeUsd: () => undefined,
      admit,
      depositFee: DEPOSIT_FEE,
    })
    expect(sent).toHaveLength(2)
  })

  it("sends a fresh quote that lands at most 1% less than the review", async () => {
    const w = world()
    provider.mockImplementationOnce(priced).mockImplementationOnce(async (asked) => {
      const fresh = await priced(asked)
      return { ...fresh, outputAmount: (fresh.outputAmount * 995n) / 1000n }
    })
    await reviewAndSend(w, request({ inputAmount: 20_000_000n }))
    expect(w.flow.state.get().repriced).toBe(false)
    expect(sent).toHaveLength(2)
  })

  it("goes back to the review, asking no wallet, when the fresh quote lands past the cap", async () => {
    const w = world()
    const r = request({ inputAmount: 20_000_000n })
    provider.mockImplementationOnce(priced).mockImplementationOnce(async (asked) => ({
      ...(await priced(asked)),
      expectedOutputAmount: 26_000_000n,
    }))
    await reviewAndSend(w, r)
    expect(w.clients).not.toHaveBeenCalled()
    expect(await w.store.all()).toEqual([])
    const shown = selectQuote(w.flow.state.get(), bridgeQuoteKey(r))!.answer!
    expect(w.flow.state.get()).toMatchObject({ step: "progress", repriced: true, sending: false })
    expect(admit(shown).problem).toBe("protocol")
  })

  it("sends a fresh quote that lands more, within the cap", async () => {
    const w = world()
    provider.mockImplementationOnce(priced).mockImplementation(async (asked) => ({
      ...(await priced(asked)),
      expectedOutputAmount: 25_000_000n,
    }))
    await reviewAndSend(w, request({ inputAmount: 20_000_000n }))
    expect(w.flow.state.get().repriced).toBe(false)
    expect(sent).toHaveLength(2)
  })

  it("goes back to the review when the quote after the approval lands past the cap", async () => {
    const w = world()
    provider
      .mockImplementationOnce(priced)
      .mockImplementationOnce(priced)
      .mockImplementationOnce(async (asked) => ({
        ...(await priced(asked)),
        expectedOutputAmount: 26_000_000n,
      }))
    await reviewAndSend(w, request({ inputAmount: 20_000_000n }))
    expect(sent.map((tx) => tx.data)).toEqual(["0xa0"])
    expect(await w.store.all()).toEqual([])
    expect(w.flow.state.get().repriced).toBe(true)
  })

  it("quotes again once the approval lands, and signs that quote's bridge call", async () => {
    const w = world()
    provider
      .mockImplementationOnce(priced)
      .mockImplementationOnce(priced)
      .mockImplementationOnce(async (asked) => {
        const fresh = await priced(asked)
        return { ...fresh, expiresAt: 123, txs: [{ ...fresh.txs[1]!, data: "0xb1" as Hex }] }
      })
    await reviewAndSend(w, request({ inputAmount: 20_000_000n }))
    expect(sent.map((tx) => tx.data)).toEqual(["0xa0", "0xb1"])
    expect(await w.saved()).toMatchObject({
      call: { to: SPOKE_POOL, data: "0xb1" },
      quoteExpiresAt: 123,
    })
  })

  it("goes back to the review, the approval kept, when the quote after it is worse", async () => {
    const w = world()
    provider
      .mockImplementationOnce(priced)
      .mockImplementationOnce(priced)
      .mockImplementationOnce(async (asked) => {
        const fresh = await priced(asked)
        return { ...fresh, outputAmount: fresh.outputAmount - 1_000_000n }
      })
    await reviewAndSend(w, request({ inputAmount: 20_000_000n }))
    expect(sent.map((tx) => tx.data)).toEqual(["0xa0"])
    expect(w.onSent).not.toHaveBeenCalled()
    expect(w.flow.state.get().repriced).toBe(true)
    expect(await w.store.all()).toEqual([])
  })

  it("stops at a reverted approval, before the bridge call, and saves nothing", async () => {
    approval = "reverted"
    const w = world()
    await reviewAndSend(w, request({ inputAmount: 20_000_000n }))
    expect(sent).toHaveLength(1)
    expect(w.report).toHaveBeenCalledOnce()
    expect(w.onSent).not.toHaveBeenCalled()
    expect(await w.store.all()).toEqual([])
  })

  it("keeps the hash and its status, and never sends again, when saving the hash fails", async () => {
    const broken = new Error("disk full")
    const w = world({ markSent: async () => Promise.reject(broken) })
    const r = request({ inputAmount: 20_000_000n })
    await reviewAndSend(w, r)
    expect(w.report).toHaveBeenCalledWith(broken, "deposit:bridge-in")
    expect(w.onSent).toHaveBeenCalledWith(DEPOSIT)
    expect(w.flow.state.get()).toMatchObject({ step: "status", sent: (await w.saved())!.id })

    await reviewAndSend(w, r)
    expect(sent).toHaveLength(2)
  })

  it("ends the signing record when the wallet refuses the bridge call", async () => {
    sendError = { code: 4001, message: "User rejected the request." }
    const w = world()
    await reviewAndSend(w, request({ inputAmount: 20_000_000n }))
    await vi.waitFor(async () => expect((await w.saved())?.status).toBe("failed"))
    expect(w.report).not.toHaveBeenCalled()
    expect(w.flow.state.get()).toMatchObject({ sending: false, sentFrom: undefined })
  })

  it("sends a review back to the amount when the wallet switches account", () => {
    const w = world()
    w.flow.go("progress")
    w.view.set({ ...w.view.get(), account: FRESH, accounts: [FRESH] })
    expect(w.flow.state.get().step).toBe("amount")
  })
})

describe("paying a request", () => {
  const owed = request({ outputAmount: 20_000_000n })
  const pays = { payee: "bob", requestId: "req-1" }
  const pulls = (most: bigint) => async (asked: BridgeInQuoteRequest) => ({
    ...(await priced(asked)),
    maxInputAmount: most,
  })

  it("saves the payment marked as one, and keeps it out of the saved wallets", async () => {
    const w = world()
    await reviewAndSend(w, owed, { fixed: true, pays })
    expect(await w.saved()).toMatchObject({ originTxHash: DEPOSIT, pays })
    expect(provider).toHaveBeenLastCalledWith(
      expect.objectContaining({ outputAmount: 20_000_000n, recipient: FRESH }),
    )
    expect(await w.contacts.all()).toEqual([])
  })

  it("goes back to the review when the most the bridge may pull rises past 1%", async () => {
    const w = world()
    provider.mockImplementationOnce(pulls(20_600_000n)).mockImplementationOnce(pulls(20_900_000n))
    await reviewAndSend(w, owed, { fixed: true, pays })
    expect(sent).toEqual([])
    expect(w.flow.state.get().repriced).toBe(true)
  })

  it("sends a fresh quote that pulls at most 1% more than the review", async () => {
    const w = world()
    provider.mockImplementation(pulls(20_600_000n))
    provider.mockImplementationOnce(pulls(20_600_000n)).mockImplementationOnce(pulls(20_800_000n))
    await reviewAndSend(w, owed, { fixed: true, pays })
    expect(sent).toHaveLength(2)
  })
})

describe("bridgeInFees", () => {
  const twenty = { inputAmount: 20_000_000n, maxInputAmount: 20_000_000n }
  const units = { fixed: false, dollars: true, inDecimals: 6, outDecimals: 18, depositFee: "0.4" }

  it("is the bridge fee plus the deposit fee, Send less Receive", () => {
    const quote = { ...twenty, outputAmount: 19_500_000_000_000_000_000n, fee: 500_000n }
    expect(bridgeInFees(quote as BridgeInQuote, units)).toEqual({ bridge: "0.5", whole: "0.9" })
  })

  it("charges a dollar coin's whole loss to what lands, whatever fee the provider names", () => {
    const quote = { ...twenty, outputAmount: 19_500_000_000_000_000_000n, fee: 23_407n }
    expect(bridgeInFees(quote as BridgeInQuote, units).whole).toBe("0.9")
  })
})
