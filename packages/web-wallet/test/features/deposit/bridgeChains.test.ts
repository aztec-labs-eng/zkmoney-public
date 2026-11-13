import { describe, expect, it } from "vitest"
import { BaseError, HttpRequestError, LimitExceededRpcError, TimeoutError } from "viem"
import type { BridgeInQuote } from "@obsidion/front-core"
import type { AcrossBridge } from "@obsidion/config-client"
import {
  bridgeCharged,
  bridgeCredit,
  bridgeDepositFee,
  bridgeDollarFee,
  bridgeFeeUsd,
  bridgeInputFor,
  bridgeLanding,
  bridgeReceived,
  bridgeRefusedFee,
  bridgeRoutes,
  bridgeSize,
  bridgeUsdValue,
  firstDepositNetwork,
  isUnreachable,
  preferredBridgeChain,
} from "../../../src/features/deposit/bridgeChains"
import type { DepositTokenOption } from "../../../src/features/sipa/loadDepositFacts"

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
const USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"
type Chain = AcrossBridge["chains"][number]
const chain = (chainId: number, name: string, inTokens: Chain["in"]): Chain =>
  ({ chainId, name, etaMinutes: 2, rpcUrl: "https://rpc", in: inTokens, out: [] } as Chain)

describe("preferredBridgeChain", () => {
  it("opens on the profile's first chain that is not the L1", () => {
    const ethereum = { chainId: 1 }
    const base = { chainId: 8453 }
    const hyper = { chainId: 999 }
    expect(preferredBridgeChain([base, hyper], 1)).toBe(base)
    expect(preferredBridgeChain([ethereum, hyper, base], 1)).toBe(hyper)
    expect(preferredBridgeChain([ethereum], 1)).toBeUndefined()
    expect(preferredBridgeChain([], 1)).toBeUndefined()
  })
})

describe("firstDepositNetwork", () => {
  const L1 = 1
  const networks = [{ chainId: L1 }, { chainId: 8453 }, { chainId: 42161 }]
  const first = (over: Partial<Parameters<typeof firstDepositNetwork>[0]>) =>
    firstDepositNetwork({ networks, l1ChainId: L1, ...over })

  it("opens a wallet's flow on the wallet's chain over the remembered one", () => {
    expect(first({ intent: "wallet", walletChainId: 42161, lastNetwork: 8453 })).toBe(42161)
    expect(first({ intent: "wallet", walletChainId: L1, lastNetwork: 8453 })).toBe(L1)
  })

  it("falls back to the remembered, then the preferred chain when the wallet's is not offered", () => {
    expect(first({ intent: "wallet", walletChainId: 10, lastNetwork: 42161 })).toBe(42161)
    expect(first({ intent: "wallet", walletChainId: 10 })).toBe(8453)
  })

  it("keeps an address on the L1 and a bridge off it, whatever the wallet's chain", () => {
    expect(first({ intent: "address", walletChainId: 8453, lastNetwork: 8453 })).toBe(L1)
    expect(first({ intent: "bridge", walletChainId: 42161, lastNetwork: L1 })).toBe(8453)
  })
})

describe("bridgeUsdValue", () => {
  // 10.5 USDC in, 0.5 fee, 10 sent lands as 10 DAI (18 decimals).
  const quote = { inputAmount: 10_500_000n, fee: 500_000n, outputAmount: 10n * 10n ** 18n }

  it("prices origin units at the quote's own rate", () => {
    expect(bridgeUsdValue(quote, 500_000n, 18)).toBe("0.5")
    expect(bridgeUsdValue(quote, 10_500_000n, 18)).toBe("10.5")
  })

  it("prices nothing when the fee takes the whole input", () => {
    expect(bridgeUsdValue({ ...quote, fee: quote.inputAmount }, 1n, 18)).toBeUndefined()
  })
})

describe("bridgeFeeUsd", () => {
  const quote = { inputAmount: 2_000_000n, fee: 1_000_000n, outputAmount: 3_000_000n }

  it("takes the provider's dollar price over the quote's rate", () => {
    expect(bridgeFeeUsd({ ...quote, feeUsd: "0.98" }, 6)).toBe("0.98")
  })

  it("falls back to the quote's rate into the landing coin", () => {
    expect(bridgeFeeUsd(quote, 6)).toBe("3")
  })
})

describe("bridgeDollarFee", () => {
  it("is what is charged less what lands, across decimals", () => {
    const quote = { outputAmount: 99_846_700_000_000_000_000n }
    expect(bridgeDollarFee(quote, 100_000_000n, 6, 18)).toBe("0.1533")
  })

  it("is never below zero", () => {
    expect(bridgeDollarFee({ outputAmount: 5_000_001n }, 5_000_000n, 6, 6)).toBe("0")
  })
})

const coin = (symbol: string, swapped = false) => ({ symbol, swapped } as DepositTokenOption)

describe("bridgeLanding", () => {
  const coins = [coin("DAI"), coin("USDC", true), coin("USDT", true)]

  it("lands USDC and USDT as themselves, and any other token as USDC", () => {
    expect(bridgeLanding(coins, "USDC")).toBe(coins[1])
    expect(bridgeLanding(coins, "USDT")).toBe(coins[2])
    expect(bridgeLanding(coins, "DAI")).toBe(coins[1])
    expect(bridgeLanding(coins, "ETH")).toBe(coins[1])
    expect(bridgeLanding(coins, "WBTC")).toBe(coins[1])
    expect(bridgeLanding(coins.slice(0, 2), "USDT")).toBe(coins[1])
  })

  it("lands nothing where the table offers no USDC for a token Across swaps", () => {
    expect(bridgeLanding([coin("DAI")], "DAI")).toBeUndefined()
    expect(bridgeLanding([coin("DAI")], "ETH")).toBeUndefined()
    expect(bridgeLanding([coin("DAI")], "USDT")).toBeUndefined()
    expect(bridgeLanding(coins, undefined)).toBeUndefined()
  })
})

describe("bridgeCredit", () => {
  const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
  const dai: DepositTokenOption = {
    symbol: "DAI",
    address: DAI,
    decimals: 18,
    icon: "",
    settlesIn: DAI,
    swapped: false,
  }
  const usdc: DepositTokenOption = {
    symbol: "USDC",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    icon: "",
    settlesIn: "0x6b175474e89094c44da98b954eedeac495271d0f",
    swapped: true,
  }

  it("names the row token a swapped landing credits, as approximate", () => {
    expect(bridgeCredit([dai, usdc], usdc)).toEqual({ coin: dai, approx: true })
  })

  it("credits a DAI origin's USDC landing as approximate DAI", () => {
    const coins = [dai, usdc]
    expect(bridgeCredit(coins, bridgeLanding(coins, "DAI"))).toEqual({ coin: dai, approx: true })
  })

  it("names a landing that is its own row token, as exact", () => {
    expect(bridgeCredit([dai, usdc], dai)).toEqual({ coin: dai, approx: false })
  })

  it("names the landing where its row token is not offered", () => {
    expect(bridgeCredit([usdc], usdc)).toEqual({ coin: usdc, approx: true })
    expect(bridgeCredit([dai, usdc], undefined)).toBeUndefined()
  })
})

describe("bridgeRoutes", () => {
  const bridge = {
    apiUrl: "https://a",
    oxide: {},
    chains: [
      chain(8453, "Base", [
        { symbol: "USDC", address: USDC },
        { symbol: "ETH", native: true },
        { symbol: "USDT", address: USDT },
      ]),
      chain(10, "Optimism", [{ symbol: "USDC", address: USDC, comingSoon: true }]),
      chain(42161, "Arbitrum", [
        { symbol: "ETH", native: true, comingSoon: true },
        { symbol: "USDC", address: USDC },
      ]),
    ],
  } as AcrossBridge

  it("lists the chains with a token to bridge now, in profile order, every token with a landing", () => {
    const routes = bridgeRoutes(bridge, [coin("USDC")])
    expect(routes.map((r) => r.chain.name)).toEqual(["Base", "Arbitrum"])
    expect(routes[1]!.tokens.map((t) => t.symbol)).toEqual(["ETH", "USDC"])
  })

  it("leaves out a token, and a chain, with no landing", () => {
    const routes = bridgeRoutes(bridge, [coin("USDT")])
    expect(routes.map((r) => r.chain.name)).toEqual(["Base"])
    expect(routes[0]!.tokens.map((t) => t.symbol)).toEqual(["USDT"])
    expect(bridgeRoutes(bridge, [coin("DAI")])).toEqual([])
  })

  it("keeps only the tokens that land as themselves for an exact amount", () => {
    const routes = bridgeRoutes(bridge, [coin("USDC")], { sameToken: true })
    expect(routes.map((r) => r.chain.name)).toEqual(["Base", "Arbitrum"])
    expect(routes[0]!.tokens.map((t) => t.symbol)).toEqual(["USDC"])
  })
})

describe("bridgeInputFor", () => {
  // 10.5 sent at 0.5 of fee: at least 950 lands, 1000 expected.
  const quote = { inputAmount: 10_500n, fee: 500n, outputAmount: 950n, expectedOutputAmount: 1000n }

  it("sends what lands the amount at the guaranteed minimum, the fee on top", () => {
    expect(bridgeInputFor(quote, 1900n)).toBe(20_500n)
  })

  it.each([
    ["sends nothing", { ...quote, inputAmount: 500n }],
    ["lands nothing", { ...quote, outputAmount: 0n }],
  ])("has no rate when the quote %s", (_, q) => {
    expect(bridgeInputFor(q, 1900n)).toBeUndefined()
  })
})

describe("bridgeReceived", () => {
  it.each([
    ["the typed To when the minimum covers it", 2_010n, 2_000n, 2_000n],
    ["the typed To when the minimum is exactly it", 2_000n, 2_000n, 2_000n],
    ["the minimum when it falls short of the typed To", 1_990n, 2_000n, 1_990n],
    ["the minimum when nothing was typed in To", 2_010n, undefined, 2_010n],
  ])("shows %s", (_, minimum, typed, shown) => {
    expect(bridgeReceived(minimum, typed)).toBe(shown)
  })
})

describe("bridgeSize", () => {
  const size = (over: Partial<Parameters<typeof bridgeSize>[0]>) =>
    bridgeSize({ amount: "", side: "from", maxed: false, inDecimals: 6, outDecimals: 18, ...over })
  const fee = (atomic: bigint) => atomic + 5n * 10n ** 17n
  // 100 USDC typed in To on an ETH route that holds no rate yet.
  const probe = {
    amount: "100",
    side: "to" as const,
    needed: (a: bigint) => a,
    inDecimals: 18,
    outDecimals: 6,
    originSwap: true,
  }

  it.each([
    [
      "From sends the typed amount, fee included",
      { amount: "500.5" },
      { inputAmount: 500_500_000n },
    ],
    [
      "MAX sends the whole balance, the fee coming out of it",
      { amount: "999.99", maxed: true, balance: 1_000_000_000n },
      { inputAmount: 1_000_000_000n },
    ],
    [
      "a request lands its fixed amount exactly, the fee on top",
      { amount: "20", fixedAmount: "20", maxed: true, balance: 1n },
      { outputAmount: 20n * 10n ** 18n },
    ],
    [
      "To lands what the private balance needs",
      { amount: "100", side: "to" as const, needed: fee },
      { outputAmount: 1005n * 10n ** 17n },
    ],
    [
      "To quotes nothing until the deposit fee is known",
      { amount: "100", side: "to" as const, needed: () => undefined },
      undefined,
    ],
    [
      "To on a swap route sends what lands that much at the rate, the fee on top",
      // 0.5 ETH of fee; 10 ETH quoted lands at least 9.5 ETH worth, 950 USDC.
      {
        amount: "100",
        side: "to" as const,
        needed: (a: bigint) => a,
        inDecimals: 18,
        outDecimals: 6,
        originSwap: true,
        rate: {
          inputAmount: 10n * 10n ** 18n,
          fee: 5n * 10n ** 17n,
          outputAmount: 950_000_000n,
        },
      },
      { inputAmount: 10n ** 18n + 5n * 10n ** 17n },
    ],
    [
      "To on a swap route with no rate and no balance read quotes one origin coin to read one",
      probe,
      { inputAmount: 10n ** 18n },
    ],
    [
      "with a zero balance it quotes one origin coin",
      { ...probe, balance: 0n },
      { inputAmount: 10n ** 18n },
    ],
    [
      "with less than one coin it quotes the balance",
      { ...probe, balance: 10n ** 17n },
      { inputAmount: 10n ** 17n },
    ],
    [
      "with more than one coin it quotes one coin, whatever To asks for",
      { ...probe, balance: 500n * 10n ** 18n },
      { inputAmount: 10n ** 18n },
    ],
    ["zero quotes nothing", { amount: "0" }, undefined],
    ["more decimals than the coin quotes nothing", { amount: "1.1234567" }, undefined],
  ])("%s", (_, over, request) => {
    expect(size(over).request).toEqual(request)
  })
})

describe("bridgeCharged", () => {
  const quote = { inputAmount: 20_500_000n, maxInputAmount: 20_600_000n }

  it("charges a deposit its quote's input and a request the most the bridge may pull", () => {
    expect(bridgeCharged(quote, false)).toBe(20_500_000n)
    expect(bridgeCharged(quote, true)).toBe(20_600_000n)
  })
})

describe("bridgeRefusedFee", () => {
  // Across: "Bridge amount 3000000 is too low to cover bridge fees 3313944".
  const refused = { amount: 3_000_000n, fee: 3_313_944n }
  const base = {
    refused,
    typed: 3_000_000n,
    output: 3_000_000n,
    exactOutput: false,
    dollars: true,
    inDecimals: 6,
    outDecimals: 18,
    symbol: "USDC",
    depositFee: "0.4",
  }
  const rate = {
    inputAmount: 1n * 10n ** 18n,
    fee: 0n,
    outputAmount: 3000n * 10n ** 18n,
  } as BridgeInQuote

  it.each([
    ["a dollar coin's whole fee in dollars", {}, "$3.71"],
    [
      "an exact output's whole fee at the landing coin",
      { exactOutput: true, output: 3n * 10n ** 18n },
      "$3.71",
    ],
    [
      "another coin's whole fee at the last quote's rate",
      { dollars: false, inDecimals: 18, typed: 10n ** 15n, symbol: "ETH", rate },
      "$3.71",
    ],
    [
      "another coin's bridge fee in that coin without a quote",
      { dollars: false, inDecimals: 18, typed: 10n ** 15n, symbol: "ETH" },
      "0.0011 ETH",
    ],
    ["nothing without a refusal", { refused: undefined }, undefined],
    ["nothing for a zero amount", { refused: { amount: 0n, fee: 1n } }, undefined],
    ["nothing before an amount is typed", { typed: undefined }, undefined],
  ])("names %s", (_, over, figure) => {
    expect(bridgeRefusedFee({ ...base, ...over })).toBe(figure)
  })
})

describe("bridgeDepositFee", () => {
  const dai = { symbol: "DAI", decimals: 18 }
  const { arriving, needed } = bridgeDepositFee(dai, "0.4")

  it.each([
    [
      "the landing less the deposit fee",
      2_660_000_000_000_000_000n,
      2_260_000_000_000_000_000n,
      "2.26",
    ],
    ["nothing when the landing does not cover the fee", 300_000_000_000_000_000n, 0n, "0"],
  ])("reaches the private funds with %s", (_, landed, atomic, amount) => {
    expect(arriving(landed)).toEqual({ atomic, amount, symbol: "DAI" })
  })

  it("asks to land the target plus the deposit fee", () => {
    expect(needed(2_220_000_000_000_000_000n)).toBe(2_620_000_000_000_000_000n)
  })
})

describe("isUnreachable", () => {
  it.each([
    [
      "a refused request",
      new HttpRequestError({ url: "https://mainnet.base.org", status: 429 }),
      true,
    ],
    ["a timeout", new TimeoutError({ body: {}, url: "https://mainnet.base.org" }), true],
    ["a rate limit", new LimitExceededRpcError(new Error("limit")), true],
    [
      "a wrapped refusal",
      new BaseError("read failed", { cause: new HttpRequestError({ url: "x" }) }),
      true,
    ],
    ["another viem error", new BaseError("reverted"), false],
    ["a plain error", new Error("rpc down"), false],
  ])("%s is unreachable: %s", (_, error, unreachable) => {
    expect(isUnreachable(error)).toBe(unreachable)
  })
})
