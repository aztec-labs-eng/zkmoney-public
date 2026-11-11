// @vitest-environment node
/**
 * Every route that funds a deposit address refuses, before any wallet call, an ask the portal
 * cannot take: the same asks run through the Ethereum send and the bridge-in send.
 */
import { describe, expect, it } from "vitest"
import { formatUnits, parseUnits, type Address, type Hex } from "viem"
import { createPace } from "@obsidion/core/cadence"
import {
  admitDeposit,
  createBridgeIns,
  memoryBackend,
  memoryStore,
  openDatabase,
  type BridgeInQuote,
  type BridgeInQuoteRequest,
  type DepositLanding,
  type UsdValuation,
} from "@obsidion/front-core"
import type { L1WalletView } from "../../../src/session/l1Wallet"
import { createWalletPrompt } from "../../../src/session/walletPrompt"
import { fundDeposit, type FundDepositDeps } from "../../../src/features/deposit/fundDeposit"
import { openFundFlow } from "../../../src/features/deposit/DepositFromWalletModal/fundFromWalletFlow"
import { openBridgeInFlow } from "../../../src/features/deposit/BridgeInModal/bridgeInFlow"
import { bridgeInStart } from "../../../src/features/deposit/BridgeInModal/bridgeInTransition"
import { FundingPreflightError } from "../../../src/features/deposit/fundingPreflight"
import type { DepositTokenOption } from "../../../src/features/sipa/loadDepositFacts"
import { FAKE_ACTIVE_KEY, fakeCapacityStore } from "../../support/fakeCapacity"
import { testQuery } from "../../support/query"

const ACCOUNT = `0x${"a1".repeat(20)}` as Address
const ADDRESS = `0x${"5e".repeat(20)}` as Address
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address
/** The landing coin is the bucket's own token. */
const DAI = FAKE_ACTIVE_KEY.token as Address
const dai = (display: string) => parseUnits(display, 18)
const SHOWN_FEE = "0.4"
const CAP = dai("5166")
const token = {
  address: DAI,
  symbol: "DAI",
  decimals: 18,
  icon: "",
  settlesIn: DAI,
  swapped: false,
} as DepositTokenOption
const landing: DepositLanding = {
  token,
  depositFeeAtomic: dai(SHOWN_FEE),
  txAmountCap: CAP,
  minimumAtomic: dai("1"),
}
const price = (numerator: bigint, denominator = 1n): UsdValuation => ({
  source: "test",
  usdPerToken: { numerator, denominator },
})

interface Ask {
  landed: bigint
  valuation: UsdValuation
  available: bigint
  freshFee: string
}
const ok: Ask = {
  landed: dai("100"),
  valuation: price(1n),
  available: dai("1000"),
  freshFee: "0.4",
}

/** The same ask as each route makes it: Ethereum sends what lands, a bridge sends USDC. */
const admitted = (ask: Ask, route: "ethereum" | "bridge") =>
  admitDeposit(landing, {
    landedAtomic: ask.landed,
    gross:
      route === "ethereum"
        ? { atomic: ask.landed, decimals: 18, valuation: ask.valuation }
        : { atomic: ask.landed / 10n ** 12n, decimals: 6, valuation: ask.valuation },
  })

let epoch = 0
const bucket = (available: bigint) =>
  fakeCapacityStore({ availableAtomic: available, epoch: ++epoch }).depositCapacityStore(
    undefined,
    FAKE_ACTIVE_KEY,
  )

/** The Ethereum send over the real transfer, its chain and wallet faked. */
async function sendFromEthereum(ask: Ask) {
  const walletCalls: unknown[] = []
  const deps = {
    deposits: { apply: async () => undefined },
    wakeBroadcasts: () => {},
    tuple: async () => ({ token: DAI }),
    publicClient: { waitForTransactionReceipt: async () => ({ status: "success" }) },
    pace: { foreignMs: (ms: number) => ms },
    config: { l1ChainId: 1 },
    tokenMetadata: async () => ({ symbol: "DAI", decimals: 18 }),
    displayFacts: async () => ({
      fee: ask.freshFee,
      token: DAI,
      sweepFeeAtomic: dai(ask.freshFee),
      txAmountCap: CAP,
    }),
    balance: async () => ({
      raw: dai("100000"),
      value: 0,
      decimals: 18,
      symbol: "DAI",
      display: "",
    }),
    l1Clients: async () => ({
      account: ACCOUNT,
      chain: { id: 1 },
      walletClient: {
        writeContract: async (call: unknown) => {
          walletCalls.push(call)
          return `0x${"0f".repeat(32)}` as Hex
        },
      },
    }),
    desktop: { active: () => false, submit: async () => `0x${"0f".repeat(32)}` as Hex },
  } as unknown as FundDepositDeps
  const admission = admitted(ask, "ethereum")
  const view = memoryStore<L1WalletView>({
    account: ACCOUNT,
    accounts: [ACCOUNT],
    chainId: 1,
    walletName: "Rabby",
    connecting: false,
    reopening: false,
  })
  const flow = openFundFlow(
    {
      l1Wallet: { view: view.readonly, switchNetwork: async () => true },
      walletPrompt: createWalletPrompt(),
      pace: createPace({ signalled: true }),
      now: () => 0,
      chainId: 1,
      fundDeposit: (params) => fundDeposit(params, deps),
      report: () => {},
    },
    () => ({
      canSubmit: true,
      wrongChain: false,
      transfer: {
        charged: formatUnits(ask.landed, 18),
        amountAtomic: ask.landed - dai(SHOWN_FEE),
        admission,
      },
      account: ACCOUNT,
      walletName: "Rabby",
      deposit: { address: ADDRESS, name: "alice.oxide.eth" },
      token,
      fee: SHOWN_FEE,
      mint: false,
      capacity: bucket(ask.available),
      onApproving: async () => {},
      onNotApproved: () => {},
      onSent: () => {},
      onSendFailed: () => {},
      onSendUnresolved: () => {},
    }),
  )
  flow.start(new AbortController().signal)
  flow.review(SHOWN_FEE)
  await flow.send()
  const s = flow.state.get()
  const refused =
    s.note && "error" in s.note && s.note.error instanceof FundingPreflightError
      ? "capacity"
      : s.review.changed
      ? "fee-changed"
      : undefined
  return { walletCalls: walletCalls.length, refused }
}

/** The bridge-in send over a fake provider and origin wallet. */
async function sendFromBridge(ask: Ask) {
  const walletCalls: unknown[] = []
  const quoted = async (r: BridgeInQuoteRequest): Promise<BridgeInQuote> => ({
    inputAmount: r.inputAmount!,
    maxInputAmount: r.inputAmount!,
    outputAmount: ask.landed,
    expectedOutputAmount: ask.landed,
    fee: 0n,
    fillSeconds: 10,
    txs: [{ chainId: 8453, to: BASE_USDC, data: "0xb0" }],
  })
  const db = openDatabase(memoryBackend())
  const bridgeIns = createBridgeIns({ db })
  const view = memoryStore<L1WalletView>({
    account: ACCOUNT,
    accounts: [ACCOUNT],
    chainId: 8453,
    walletName: "Rabby",
    connecting: false,
    reopening: false,
  })
  const quote = testQuery()<[BridgeInQuoteRequest], BridgeInQuote>("bridgeInQuote", {
    load: quoted,
    stale: 0,
  })
  const flow = openBridgeInFlow(
    {
      l1Wallet: {
        view: view.readonly,
        clients: async () => ({
          account: ACCOUNT,
          chain: { id: 8453 } as never,
          walletClient: {
            sendTransaction: async (tx: unknown) => {
              walletCalls.push(tx)
              return `0x${"02".repeat(32)}` as Hex
            },
          } as never,
        }),
      },
      quote,
      reader: () => ({
        waitForTransactionReceipt: (async () => ({ status: "success" })) as never,
        getTransactionCount: (async () => 7) as never,
      }),
      depositFee: async () => ask.freshFee,
      bridgeIns,
      track: () => {},
      now: () => 1_000,
      initial: bridgeInStart(undefined, { chain: 8453, token: "USDC" }),
      report: () => {},
    },
    () => ({ onSent: () => {} }),
  )
  flow.start(new AbortController().signal)
  const request: BridgeInQuoteRequest = {
    originChainId: 8453,
    inputToken: BASE_USDC,
    destinationChainId: 1,
    outputToken: DAI,
    outputSymbol: "DAI",
    depositor: ACCOUNT,
    recipient: ACCOUNT,
    inputAmount: ask.landed / 10n ** 12n,
  }
  await flow.send({
    key: "review",
    reviewed: await quoted(request),
    request,
    fixed: false,
    recipient: async () => ADDRESS,
    units: { symbol: "USDC", inputDecimals: 6, outputSymbol: "DAI", outputDecimals: 18 },
    feeUsd: () => undefined,
    admit: () => admitted(ask, "bridge"),
    capacity: bucket(ask.available),
    depositFee: { shown: SHOWN_FEE, row: DAI },
  })
  const records = await bridgeIns.all()
  return { walletCalls: walletCalls.length, refused: flow.state.get().failure, records }
}

describe.each([
  ["Ethereum", sendFromEthereum],
  ["bridge-in", sendFromBridge],
] as const)("the %s send", (_, send) => {
  it.each<[string, Ask, string | undefined]>([
    // A cheap valuation lifts the published limit above the cap.
    [
      "over the cap",
      { ...ok, landed: CAP + dai(SHOWN_FEE) + 1n, valuation: price(4n, 10n) },
      undefined,
    ],
    ["over the published limit", { ...ok, landed: dai("5001") }, undefined],
    ["over the capacity", { ...ok, available: dai("10") }, "capacity"],
    ["after the fee changed", { ...ok, freshFee: "0.5" }, "fee-changed"],
  ])("refuses an ask %s before any wallet call", async (_, ask, refused) => {
    const result = await send(ask)
    expect(result.walletCalls).toBe(0)
    expect(result.refused).toBe(refused)
    if ("records" in result) expect(result.records).toEqual([])
  })

  it("asks the wallet for an ask the portal takes", async () => {
    const result = await send(ok)
    expect(result.walletCalls).toBeGreaterThan(0)
    expect(result.refused).toBeUndefined()
  })
})
