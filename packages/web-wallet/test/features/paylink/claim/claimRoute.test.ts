/** The claim-to-wallet modal's bridge route: its quote, kept while a new tip prices it, and its leg. */
import { describe, expect, it } from "vitest"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { WalletError } from "@obsidion/front-core"
import {
  bridgeOutQueries,
  type BridgeOutAsk,
  type BridgeOutChain,
  type BridgeOutPriced,
} from "../../../../src/features/withdraw/bridgeOutQuote"
import { openClaimRouteFlow } from "../../../../src/features/paylink/claimRouteFlow"
import {
  claimBridgeChoice,
  claimBridgeCovers,
  selectClaimBridge,
} from "../../../../src/features/paylink/claimBridgeView"
import { defaultConfig } from "../../../support/page"
import { testQuery } from "../../../support/query"

const base = {
  chainId: 8453,
  name: "Base",
  etaMinutes: 2,
  rpcUrl: "https://base.example",
  in: [],
  out: [],
}
const L2_TOKEN = `0x${"0b".repeat(32)}`
const ROUTES: BridgeOutChain[] = [
  {
    provider: "across",
    l2Token: L2_TOKEN,
    chain: base,
    tokens: [{ symbol: "USDC", address: `0x${"0b".repeat(20)}` }],
  },
]
const AMOUNT = 25n * 10n ** 18n
const TIP = 10n ** 17n
const ask = (proverTip: bigint): BridgeOutAsk => ({
  provider: "across",
  l2Token: L2_TOKEN,
  chainId: base.chainId,
  token: "USDC",
  amount: AMOUNT,
  proverTip,
})
const priced = (proverTip: bigint) =>
  ({
    minReceived: 24_500_000n,
    withdrawalFee: 10n ** 17n,
    proverTip,
  } as BridgeOutPriced)

/** A flow over a quote Query whose loads wait for `answer`. */
function setup() {
  const waiting: ((quote: BridgeOutPriced | Error) => void)[] = []
  const { bridgeOutQuote } = bridgeOutQueries(
    testQuery(),
    { config: defaultConfig, chain: {} as never },
    {
      bridgeOut: () => null,
      quote: () =>
        new Promise((resolve, reject) =>
          waiting.push((q) => (q instanceof Error ? reject(q) : resolve(q))),
        ),
    },
  )
  const flow = openClaimRouteFlow({ quotes: bridgeOutQuote })
  flow.choose({ kind: "bridge", chainId: base.chainId, token: "USDC" })
  const answer = async (q: BridgeOutPriced | Error) => {
    waiting.shift()!(q)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const view = (proverTip: bigint) => {
    const read = flow.quote(ask(proverTip))
    return { off: read.subscribe(() => {}), read }
  }
  const bridge = (read: ReturnType<typeof view>["read"]) =>
    selectClaimBridge(flow.state.get(), ROUTES, AMOUNT, read.get())!
  return { flow, answer, view, bridge }
}

describe("claim to another chain", () => {
  it("burns the chosen chain, token and quote with the tip it was priced on", async () => {
    const { answer, view, bridge } = setup()
    const { read } = view(TIP)
    await answer(priced(TIP))
    expect(claimBridgeChoice(bridge(read), TIP)).toEqual({
      chain: base,
      token: "USDC",
      quote: priced(TIP),
      proverTip: TIP,
    })
    // The fee is what the amount does not land, in DAI units.
    expect(bridge(read).feeAtomic).toBe(AMOUNT - 24_500_000n * 10n ** 12n)
  })

  it("keeps the last quote while a new tip prices it, and confirms nothing until it lands", async () => {
    const { answer, view, bridge } = setup()
    const first = view(0n)
    await answer(priced(0n))
    first.off()
    const { read } = view(TIP)
    expect(bridge(read).quote).toEqual(priced(0n))
    expect(claimBridgeChoice(bridge(read), TIP)).toBeUndefined()
    await answer(priced(TIP))
    expect(claimBridgeChoice(bridge(read), TIP)?.quote).toEqual(priced(TIP))
  })

  it("drops the quote once another chain or Ethereum is chosen", async () => {
    const { flow, answer, view, bridge } = setup()
    const { read } = view(0n)
    await answer(priced(0n))
    flow.choose({ kind: "ethereum", asset: "DAI" })
    expect(selectClaimBridge(flow.state.get(), ROUTES, AMOUNT, read.get())).toBeUndefined()
    flow.choose({ kind: "bridge", chainId: base.chainId, token: "USDC" })
    expect(bridge(read).quote).toBeUndefined()
  })

  it("says the quote failed, and when the amount is under the floor", async () => {
    const { answer, view, bridge } = setup()
    const failed = view(0n)
    await answer(new WalletError("bridge.quoteFailed", "down"))
    expect(bridge(failed.read)).toMatchObject({ failed: true })
    expect(bridge(failed.read).quote).toBeUndefined()
    const below = view(TIP)
    await answer(new WalletError("withdraw.bridgeBelowFloor", "below", { data: { floor: "9" } }))
    expect(bridge(below.read)).toMatchObject({ failed: true })
    expect(bridge(below.read).quote).toBeUndefined()
  })

  it("burns the quote priced again at confirm when it lands within the tolerance", async () => {
    const { flow, answer, view, bridge } = setup()
    const { read } = view(TIP)
    await answer(priced(TIP))
    const fresh = { ...priced(TIP), minReceived: 24_400_000n }
    const sending = flow.sendable(ask(TIP), priced(TIP))
    await answer(fresh)
    expect(await sending).toEqual(fresh)
    expect(bridge(read).quote).toEqual(fresh)
  })

  it("burns nothing when the confirm's quote lands worse, and the review shows that quote", async () => {
    const { flow, answer, view, bridge } = setup()
    const { read } = view(TIP)
    await answer(priced(TIP))
    const worse = { ...priced(TIP), minReceived: 24_000_000n }
    const sending = flow.sendable(ask(TIP), priced(TIP))
    await answer(worse)
    expect(await sending).toBeUndefined()
    expect(bridge(read).quote).toEqual(worse)
  })

  it("lets Faster's tip ride only when the amount covers the withdrawal with it", async () => {
    const { answer, view, bridge } = setup()
    const { read } = view(0n)
    await answer(priced(0n))
    const room = AMOUNT - 10n ** 17n - WITHDRAW_RELAYER_TIP
    expect(claimBridgeCovers(bridge(read), AMOUNT, room - 1n)).toBe(true)
    expect(claimBridgeCovers(bridge(read), AMOUNT, room)).toBe(false)
  })
})
