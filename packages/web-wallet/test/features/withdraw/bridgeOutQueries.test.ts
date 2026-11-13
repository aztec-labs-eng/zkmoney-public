/** The bridge-out quote and routes Queries, and the floor an answer names. */
import { describe, expect, it, vi } from "vitest"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { WalletError } from "@obsidion/front-core"
import {
  ACROSS_INPUT_TO_DAI,
  acrossBridgeOut,
  answerFloor,
  bridgeOutQueries,
  type BridgeOutAsk,
  type BridgeOutPriced,
} from "../../../src/features/withdraw/bridgeOutQuote"
import {
  SWAP_QUOTE_MAX_AGE_MS,
  SWAP_QUOTE_REFRESH_MS,
} from "../../../src/features/withdraw/swapQuotes"
import {
  DEMO_ACROSS_EXIT,
  DEMO_OXIDE_DEPLOYMENT,
  DEMO_OXIDE_TUPLE,
} from "../../../src/dev/demoFixtures"
import { defaultConfig } from "../../support/page"
import { testQuery } from "../../support/query"

const ASK: BridgeOutAsk = {
  provider: "across",
  l2Token: DEMO_OXIDE_TUPLE.l2Token,
  chainId: 8453,
  token: "USDC",
  amount: 10n ** 19n,
  proverTip: 3n,
}
const priced = { withdrawalFee: 100n, proverTip: 3n, acrossFee: 2n, tip: { relayerTip: 50n } }

const queries = (quote: (ask: BridgeOutAsk) => Promise<BridgeOutPriced>) =>
  bridgeOutQueries(
    testQuery(),
    { config: defaultConfig, chain: {} as never },
    { bridgeOut: () => null, quote: (_facts, ask) => quote(ask) },
  )

describe("bridgeOutQuote", () => {
  it("answers a priced quote, and a refusal under the floor as a value", async () => {
    const { bridgeOutQuote } = queries(async () => priced as never)
    expect(await bridgeOutQuote(ASK).read()).toEqual({ quote: priced })
    const below = new WalletError("withdraw.bridgeBelowFloor", "below", { data: { floor: "900" } })
    const refused = queries(() => Promise.reject(below)).bridgeOutQuote(ASK)
    expect(await refused.read()).toEqual({ below: true, floor: 900n })
  })

  it("keeps any other failure as the entry's error", async () => {
    const failed = new WalletError("bridge.quoteFailed", "down")
    const entry = queries(() => Promise.reject(failed)).bridgeOutQuote(ASK)
    await expect(entry.read()).rejects.toBe(failed)
    expect(entry.get()).toMatchObject({ status: "failed", error: failed })
  })

  it("prices again once the quote is past its max age", async () => {
    vi.useFakeTimers()
    try {
      const quote = vi.fn(async () => priced as never)
      const { bridgeOutQuote } = queries(quote)
      await bridgeOutQuote(ASK).read()
      await bridgeOutQuote({ ...ASK }).read()
      expect(quote).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(SWAP_QUOTE_MAX_AGE_MS)
      await bridgeOutQuote(ASK).read()
      expect(quote).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("prices again every refresh while a view shows it", async () => {
    vi.useFakeTimers()
    try {
      const quote = vi.fn(async () => priced as never)
      const off = queries(quote)
        .bridgeOutQuote(ASK)
        .subscribe(() => {})
      await vi.advanceTimersByTimeAsync(0)
      expect(quote).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(SWAP_QUOTE_REFRESH_MS)
      expect(quote).toHaveBeenCalledTimes(2)
      off()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("answerFloor", () => {
  it("names a refusal's floor, else the quote's fees, tips and bridge cost", () => {
    expect(answerFloor({ below: true, floor: 900n })).toBe(900n)
    expect(answerFloor({ quote: priced as never })).toBe(
      100n + WITHDRAW_RELAYER_TIP + 3n + 50n + 2n * ACROSS_INPUT_TO_DAI,
    )
  })
})

describe("bridgeOutRoutes", () => {
  it("lists the routes of every provider the page builds, for the deployment that holds the token", async () => {
    const routes = vi.fn(async (token: string) => [{ l2Token: token }] as never)
    const bridgeOut = (id: string) => (id === "across" ? ({ routes } as never) : null)
    const { bridgeOutRoutes } = bridgeOutQueries(
      testQuery(),
      { config: defaultConfig, chain: {} as never },
      { bridgeOut },
    )
    expect(await bridgeOutRoutes("0xtoken").read()).toEqual([{ l2Token: "0xtoken" }])
  })
})

describe("acrossBridgeOut", () => {
  const ACROSS = {
    apiUrl: "https://across.example",
    chains: [],
    oxide: { exit: DEMO_ACROSS_EXIT.id },
  }
  /** A retired deployment a link still holds: its own bridge, executor and escrow factory. */
  const RETIRED = {
    ...DEMO_OXIDE_TUPLE,
    bridgeId: "brg-dai-retired",
    l2Token: `0x${"0e".repeat(32)}`,
    portal: `0x${"0e".repeat(20)}`,
    plainWithdrawalExecutor: `0x${"e0".repeat(20)}`,
    acrossBridgeEscrowFactory: `0x${"fe".repeat(20)}`,
    operationExecutor: `0x${"0d".repeat(20)}`,
  }
  const RETIRED_FEE = 7n * 10n ** 16n

  it("prices a link's bridge-out on the executor fee and escrow factory of the link's deployment", async () => {
    const executorAt = vi.fn((address: string) => ({
      read: async () => ({ address, fee: RETIRED_FEE, portal: RETIRED.portal }),
    }))
    const facts = {
      config: { ...defaultConfig, features: { across: ACROSS } },
      // The pinned deployment only enables the exit: the link's own deployment prices the burn.
      chain: {
        withdrawalExecutorAt: executorAt,
        oxideTuple: undefined,
        oxideDeployment: { read: async () => DEMO_OXIDE_DEPLOYMENT },
      },
    }
    const price = vi.fn(async () => ({ acrossFee: 1n, minReceived: 2n, tip: { relayerTip: 3n } }))
    const tupleOf = vi.fn(async () => RETIRED)
    const across = acrossBridgeOut(facts as never, {
      tupleOf,
      client: () => ({} as never),
      price: price as never,
    })

    const quote = await across.quote({ ...ASK, l2Token: RETIRED.l2Token })

    expect(tupleOf).toHaveBeenCalledWith(RETIRED.l2Token)
    expect(quote).toMatchObject({ withdrawalFee: RETIRED_FEE, proverTip: ASK.proverTip })
    expect(price).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ acrossBridgeEscrowFactory: RETIRED.acrossBridgeEscrowFactory }),
      expect.objectContaining({ withdrawalFee: RETIRED_FEE }),
    )
  })
})
