/** What a withdrawal pays and lands on each route, and when it may continue. */
import { describe, expect, it } from "vitest"
import { getAddress, parseUnits } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { BalanceView } from "@obsidion/front-core"
import { withdrawInitial } from "../../../src/features/withdraw/WithdrawFlow/withdrawFlow"
import type { WithdrawState } from "../../../src/features/withdraw/WithdrawFlow/withdrawTransition"
import {
  bridgeOutDecimals,
  type BridgeOutChain,
  type BridgeOutPriced,
} from "../../../src/features/withdraw/bridgeOutQuote"
import type { WithdrawalQuoteState } from "../../../src/features/withdraw/withdrawQuote"
import {
  bridgeKey,
  feeRoute,
  selectWithdrawQuote,
  type WithdrawQuotes,
} from "../../../src/features/withdraw/withdrawQuoteView"

const RECIPIENT = getAddress(`0x${"11".repeat(20)}`)
const L1 = 1
const BASE = 8453
const USDC_DECIMALS = bridgeOutDecimals("USDC", BASE)
const dai = (amount: string) => parseUnits(amount, 18)

const wallet = (readThisSession = true, main = dai("100")): BalanceView => ({
  main: { atomic: main },
  readThisSession,
  known: true,
  syncing: false,
  progress: null,
  readAt: undefined,
  token: null,
  anchor: undefined,
})

const ROUTE: BridgeOutChain = {
  provider: "across",
  l2Token: `0x${"0b".repeat(32)}`,
  chain: { chainId: BASE, name: "Base", etaMinutes: 3, rpcUrl: "https://base.example", in: [] },
  tokens: [{ symbol: "USDC", address: getAddress(`0x${"22".repeat(20)}`) }],
}

/** A route's quote: the executor's fee, the tips, and a swap's output when it has one. */
const quoted = (floor: string, amountOut?: bigint, decimals = 18): WithdrawalQuoteState => ({
  status: "ready",
  fee: {
    withdrawalFee: dai(floor) - WITHDRAW_RELAYER_TIP,
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    swapRelayerTip: 0n,
    proverTip: 0n,
    floorAtomic: dai(floor),
  },
  ...(amountOut !== undefined && { estimate: { amountOut, decimals } }),
})

const quotes = (over: Partial<WithdrawQuotes> = {}): WithdrawQuotes => ({
  l1ChainId: L1,
  l1Name: "Ethereum",
  routes: [ROUTE],
  ethCoins: ["DAI", "USDC", "USDT", "ETH"],
  gasOffered: true,
  contract: false,
  hasEth: false,
  fresh: true,
  cleared: true,
  speedLoading: false,
  swap: quoted("0.1"),
  gasless: quoted("0.1"),
  bridge: { status: "idle" },
  ...over,
})

const state = (over: Partial<WithdrawState> = {}): WithdrawState => ({
  ...withdrawInitial({ recipient: RECIPIENT, atAmount: true }, L1),
  ...over,
})
const typed = (text: string, over: Partial<WithdrawState> = {}) =>
  state({ amount: { text, side: "from", maxed: false }, ...over })

const bridgeQuote = (landedUsdc: string, proverTip = 0n): BridgeOutPriced => ({
  acrossFee: parseUnits("0.05", 6),
  minReceived: parseUnits(landedUsdc, USDC_DECIMALS),
  tip: {
    relayerTip: dai("0.05"),
    minPayout: dai("0.04"),
    gasUsed: 180_000n,
    maxFeePerGas: 2_000_000_000n,
    usdPerEth: 3_000n * 10n ** 8n,
    baseFee: 1_500_000_000n,
    priorityFee: 500_000_000n,
  },
  withdrawalFee: dai("0.05"),
  proverTip,
})

describe("selectWithdrawQuote", () => {
  it("holds MAX and Continue until this session's balance read lands", () => {
    const priced = quotes({ swap: quoted("0.1", dai("20")) })
    const cached = selectWithdrawQuote(typed("20"), priced, { wallet: wallet(false) })
    expect(cached.canMax).toBe(false)
    expect(cached.valid).toBe(false)
    const live = selectWithdrawQuote(typed("20"), priced, { wallet: wallet(true) })
    expect(live.canMax).toBe(true)
    expect(live.valid).toBe(true)
  })

  it("takes the direct route's fee out of From, exactly", () => {
    const v = selectWithdrawQuote(typed("20"), quotes({ swap: quoted("0.1", dai("20")) }), {
      wallet: wallet(),
    })
    expect(v.direct).toBe(true)
    expect(v.feeAtomic).toBe(dai("0.1"))
    expect(v.receivedAtomic).toBe(dai("19.9"))
    expect(v.burnAtomic).toBe(dai("20"))
    expect(v.plan()).toMatchObject({
      amountAtomic: dai("20"),
      burnAtomic: dai("20"),
      receivedAtomic: dai("19.9"),
      gasAtomic: 0n,
      route: { kind: "direct" },
    })
  })

  it("lands a swap's no-gas output, and adds the gas share and what it costs to the burn", () => {
    const received = parseUnits("19.5", 6)
    const s = typed("20", { route: { chainId: L1, coin: "USDC" } })
    const plain = selectWithdrawQuote(s, quotes({ swap: quoted("0.3", received, 6) }), {
      wallet: wallet(),
    })
    expect(plain.feeAtomic).toBe(dai("0.3"))
    expect(plain.receivedAtomic).toBe(received)
    expect(plain.plan()?.route.kind).toBe("swap")

    const withGas = { ...s, history: [...s.history, "gas" as const], gasAtomic: dai("5") }
    // The main quote prices From and the gas share without the top-up, so its output falls short.
    const short = received - parseUnits("0.12", 6)
    const v = selectWithdrawQuote(
      withGas,
      quotes({ swap: quoted("0.42", short, 6), gasless: quoted("0.3", received, 6) }),
      { wallet: wallet() },
    )
    expect(v.gasAtomic).toBe(dai("5"))
    expect(v.topUp).toBe(dai("0.12"))
    expect(v.burnAtomic).toBe(dai("25.12"))
    expect(v.wholeAtomic).toBe(dai("0.42"))
    expect(v.receivedAtomic).toBe(received)
    expect(v.plan()).toMatchObject({
      gasAtomic: dai("5"),
      burnAtomic: dai("25.12"),
      receivedAtomic: received,
      route: { kind: "swap", quote: { amountOut: received, relayerTip: expect.anything() } },
      fresh: true,
    })
  })

  it("offers no gas step to ETH, which lands as gas itself", () => {
    const received = parseUnits("0.0065", 18)
    const s = typed("20", { route: { chainId: L1, coin: "ETH" } })
    const v = selectWithdrawQuote(s, quotes({ swap: quoted("0.3", received) }), {
      wallet: wallet(),
    })
    expect(v.gasStep).toBe(false)
    expect(v.burnAtomic).toBe(dai("20"))
    expect(v.plan()).toMatchObject({
      gasAtomic: 0n,
      route: { kind: "swap", quote: { amountOut: received } },
    })
  })

  it("prices a bridge from its kept answer: the fee is From less what lands", () => {
    const amount = dai("100")
    const ask = { chainId: BASE, token: "USDC" as const, amount }
    const quote = bridgeQuote("99.4")
    const s = typed("100", {
      route: { chainId: BASE, coin: "USDC" },
      bridge: { key: bridgeKey(ask), answer: { quote } },
    })
    const v = selectWithdrawQuote(s, quotes({ bridge: { status: "answered" } }), {
      wallet: wallet(),
    })
    expect(v.onL1).toBe(false)
    expect(v.feeAtomic).toBe(dai("0.6"))
    expect(v.receivedAtomic).toBe(quote.minReceived)
    expect(v.bridgeChoice).toEqual({ chain: ROUTE.chain, token: "USDC", quote, proverTip: 0n })
    expect(v.plan()?.route).toEqual({
      kind: "bridge",
      choice: { chain: ROUTE.chain, token: "USDC", quote },
    })
  })

  it("warns on a contract recipient on any route, and lets it through", () => {
    const amount = dai("100")
    const s = typed("100", {
      route: { chainId: BASE, coin: "USDC" },
      bridge: {
        key: bridgeKey({ chainId: BASE, token: "USDC", amount }),
        answer: { quote: bridgeQuote("99.4") },
      },
    })
    const answered = { bridge: { status: "answered" as const } }
    const toWallet = selectWithdrawQuote(s, quotes(answered), { wallet: wallet() })
    expect(toWallet.valid).toBe(true)
    const toContract = selectWithdrawQuote(s, quotes({ ...answered, contract: true }), {
      wallet: wallet(),
    })
    expect(toContract.onContract).toBe(true)
    expect(toContract.valid).toBe(true)

    const onL1 = selectWithdrawQuote(
      typed("20"),
      quotes({ contract: true, swap: quoted("0.1", dai("20")) }),
      { wallet: wallet() },
    )
    expect(onL1.onContract).toBe(true)
    expect(onL1.valid).toBe(true)
  })

  it("estimates the whole trip: the release, plus the bridge chain's time on a bridge-out", () => {
    const eta = { eta: { standardSeconds: 1800 } }
    const l1 = selectWithdrawQuote(
      typed("20"),
      quotes({ ...eta, swap: quoted("0.1", dai("20")) }),
      {
        wallet: wallet(),
      },
    )
    expect(l1.etaMinutes).toBe(30)
    expect(l1.plan()?.etaMinutes).toBe(30)

    const amount = dai("100")
    const s = typed("100", {
      route: { chainId: BASE, coin: "USDC" },
      bridge: {
        key: bridgeKey({ chainId: BASE, token: "USDC", amount }),
        answer: { quote: bridgeQuote("99.4") },
      },
    })
    const bridged = selectWithdrawQuote(s, quotes({ ...eta, bridge: { status: "answered" } }), {
      wallet: wallet(),
    })
    expect(bridged.etaMinutes).toBe(30 + ROUTE.chain.etaMinutes)
    expect(bridged.plan()?.etaMinutes).toBe(bridged.etaMinutes)
  })

  it("names no bridge choice until the answer is priced at the tip the burn carries", () => {
    const amount = dai("100")
    const quote = bridgeQuote("99.4")
    const offer = {
      proverTip: dai("0.4"),
      standardEtaSeconds: 1800,
      tippedEtaSeconds: 480,
      worstSpeedupSeconds: 1320,
      measured: true,
    }
    const s = typed("100", {
      route: { chainId: BASE, coin: "USDC" },
      bridge: { key: bridgeKey({ chainId: BASE, token: "USDC", amount }), answer: { quote } },
    })
    const v = selectWithdrawQuote(s, quotes({ offer, bridge: { status: "waiting" } }), {
      wallet: wallet(),
    })
    expect(v.pricedTip).toBe(dai("0.4"))
    expect(v.bridgeChoice).toBeUndefined()
    expect(v.valid).toBe(false)
  })

  it("keeps the route's last fee, faded, while a new amount is priced", () => {
    const s = typed("50", {
      route: { chainId: BASE, coin: "USDC" },
      bridge: {
        key: bridgeKey({ chainId: BASE, token: "USDC", amount: dai("100") }),
        answer: { quote: bridgeQuote("99.4") },
      },
      lastFee: { route: feeRoute(BASE, "USDC"), fee: dai("0.6") },
    })
    const v = selectWithdrawQuote(s, quotes({ bridge: { status: "waiting" } }), {
      wallet: wallet(),
    })
    expect(v.feeAtomic).toBeUndefined()
    expect(v.pricing).toBe(true)
    expect(v.staleFeeAtomic).toBe(dai("0.6"))
  })

  it("counts an amount under the bridge's fixed fees as below the fee", () => {
    const v = selectWithdrawQuote(
      typed("0.05", { route: { chainId: BASE, coin: "USDC" } }),
      quotes(),
      { wallet: wallet() },
    )
    expect(v.bridgeAsk?.probe).toBe(true)
    expect(v.belowFee).toBe(true)
    expect(v.valid).toBe(false)
  })

  it("guesses From for a typed To from its value and the fee", () => {
    const s = state({ amount: { text: "10", side: "to", maxed: false } })
    const v = selectWithdrawQuote(s, quotes(), { wallet: wallet() })
    expect(v.guessFrom(dai("10"))).toBe(dai("10.1"))
  })
})
