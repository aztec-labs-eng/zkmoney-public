/** The withdraw flow's commands: the burn and its cancel, and the To→From solve. */
import { describe, expect, it } from "vitest"
import { getAddress, parseUnits } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { WalletError } from "@obsidion/core/errors"
import { passThroughScreener, type BalanceView } from "@obsidion/front-core"
import {
  openWithdrawFlow,
  withdrawInitial,
  type SentRecord,
  type WithdrawFlowDeps,
  type WithdrawInputs,
} from "../../../src/features/withdraw/WithdrawFlow/withdrawFlow"
import type { WithdrawState } from "../../../src/features/withdraw/WithdrawFlow/withdrawTransition"
import {
  bridgeOutDecimals,
  type BridgeOutAnswer,
  type BridgeOutAsk,
  type BridgeOutChain,
} from "../../../src/features/withdraw/bridgeOutQuote"
import type { WithdrawStage } from "../../../src/features/withdraw/withdrawGateway"
import type { SwapQuote, WithdrawalQuoteState } from "../../../src/features/withdraw/withdrawQuote"
import type { SwapKey } from "../../../src/features/withdraw/swapQuotes"
import {
  selectWithdrawQuote,
  type WithdrawPlan,
  type WithdrawQuotes,
} from "../../../src/features/withdraw/withdrawQuoteView"
import { openL1Wallet } from "../../../src/session/l1Wallet"
import { testWagmi } from "../../support/page"
import { testQuery } from "../../support/query"

const RECIPIENT = getAddress(`0x${"11".repeat(20)}`)
const BASE = 8453
const USDC = bridgeOutDecimals("USDC", BASE)
const dai = (amount: string) => parseUnits(amount, 18)
/** What a bridge-out of any amount costs: 60 cents. */
const BRIDGE_COST = dai("0.6")

const WALLET: BalanceView = {
  main: { atomic: dai("500") },
  readThisSession: true,
  known: true,
  syncing: false,
  progress: null,
  readAt: undefined,
  token: null,
  anchor: undefined,
}
const ROUTE: BridgeOutChain = {
  provider: "across",
  l2Token: `0x${"0b".repeat(32)}`,
  chain: { chainId: BASE, name: "Base", etaMinutes: 3, rpcUrl: "https://base.example", in: [] },
  tokens: [{ symbol: "USDC", address: getAddress(`0x${"22".repeat(20)}`) }],
}
const DIRECT: WithdrawalQuoteState = {
  status: "ready",
  fee: {
    withdrawalFee: dai("0.1") - WITHDRAW_RELAYER_TIP,
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    swapRelayerTip: 0n,
    proverTip: 0n,
    floorAtomic: dai("0.1"),
  },
  estimate: { amountOut: dai("20"), decimals: 18 },
}
const QUOTES: WithdrawQuotes = {
  l1ChainId: 1,
  l1Name: "Ethereum",
  routes: [ROUTE],
  ethCoins: ["DAI"],
  gasOffered: false,
  contract: false,
  hasEth: false,
  fresh: false,
  cleared: true,
  speedLoading: false,
  swap: DIRECT,
  gasless: DIRECT,
  bridge: { status: "idle" },
}

/** The bridge quote: what lands is the amount less {@link BRIDGE_COST}, in USDC. */
const bridgeQuotes = () => {
  const asked: bigint[] = []
  /** What the next quote costs. */
  const market = { cost: BRIDGE_COST }
  const query = testQuery()<[BridgeOutAsk], BridgeOutAnswer>("bridgeOutQuote", {
    load: async (ask) => {
      asked.push(ask.amount)
      return {
        quote: {
          acrossFee: 0n,
          minReceived: (ask.amount - market.cost) / 10n ** BigInt(18 - USDC),
          tip: {
            relayerTip: 0n,
            minPayout: 0n,
            gasUsed: 0n,
            maxFeePerGas: 0n,
            usdPerEth: 0n,
            baseFee: 0n,
            priorityFee: 0n,
          },
          withdrawalFee: dai("0.05"),
          proverTip: ask.proverTip,
        },
      }
    },
    stale: 0,
  })
  return { query, asked, market }
}

/** A gateway that records what it burned once past `proving`, or throws what `fail` names. */
function fakeGateway(opts: { fail?: unknown; hold?: Promise<void> } = {}) {
  const burned: WithdrawPlan[] = []
  const send = async (
    plan: WithdrawPlan,
    _screener: unknown,
    onStage: (stage: WithdrawStage) => void,
  ): Promise<SentRecord> => {
    onStage("building")
    await opts.hold
    if (opts.fail) throw opts.fail
    onStage("proving")
    burned.push(plan)
    onStage("submitting")
    return {
      localId: "w1",
      phase: "l2_mined",
      rawAmount: plan.burnAtomic.toString(),
      tokenDecimals: 18,
    }
  }
  return { send, burned }
}

/** Signing windows the flow holds open. */
function fakeAuth() {
  const open = new Set<AbortController>()
  return {
    open,
    beginSigning() {
      const window = new AbortController()
      open.add(window)
      return window
    },
    endSigning(window: AbortController) {
      open.delete(window)
    },
  }
}

function harness(initial: WithdrawState, over: Partial<WithdrawFlowDeps> = {}) {
  const saved: WithdrawPlan[] = []
  const auth = fakeAuth()
  const bridge = bridgeQuotes()
  let closed = 0
  const deps: WithdrawFlowDeps = {
    initial,
    send: fakeGateway().send,
    auth,
    saveRecipient: async (plan) => void saved.push(plan),
    recordBurn: async () => {},
    l1Wallet: openL1Wallet({ wagmi: testWagmi }),
    bridgeOutQuote: bridge.query,
    swapQuote: testQuery()<[SwapKey], SwapQuote>("swapQuote", {
      load: async () => {
        throw new WalletError("unknown", "no swap here")
      },
    }),
    ...over,
  }
  const balance = { wallet: WALLET }
  const inputs = (): WithdrawInputs => ({
    view: selectWithdrawQuote(flow.state.get(), QUOTES, balance),
    quotes: QUOTES,
    balance,
    screener: passThroughScreener,
    network: "Ethereum",
    etherfiCash: false,
    saved: [],
    outcome: { start() {}, updateStage() {}, finish() {}, cancel() {} },
    handOff: { current: null },
    openPicker: () => {},
    pickerShown: () => false,
    onClose: () => void closed++,
  })
  const flow = openWithdrawFlow(deps, inputs)
  const shown = new AbortController()
  flow.start(shown.signal)
  return { flow, saved, auth, bridge, closed: () => closed }
}

/** At the review with 20 DAI typed to RECIPIENT on the direct route. */
const atReview = (): WithdrawState => ({
  ...withdrawInitial({ recipient: RECIPIENT, atAmount: true }, 1),
  history: ["address", "amount", "review"],
  amount: { text: "20", side: "from", maxed: false },
  review: { feeAtomic: dai("0.1"), changed: false },
})

describe("openWithdrawFlow: submit", () => {
  it("burns the review's plan, lands on the status with its record, and saves the recipient", async () => {
    const gateway = fakeGateway()
    const { flow, saved, auth } = harness(atReview(), { send: gateway.send })
    await flow.submit()
    const s = flow.state.get()
    expect(gateway.burned).toHaveLength(1)
    expect(gateway.burned[0]).toMatchObject({ amountAtomic: dai("20"), burnAtomic: dai("20") })
    expect(s.history.at(-1)).toBe("status")
    expect(s.sent?.localId).toBe("w1")
    expect(s.stage).toBeUndefined()
    expect(saved.map((p) => p.recipient)).toEqual([RECIPIENT])
    expect(auth.open.size).toBe(0)
  })

  it("returns to the review with the failure's code, the signing window closed", async () => {
    const gateway = fakeGateway({ fail: new WalletError("withdrawal.failed", "test") })
    const { flow, saved, auth } = harness(atReview(), { send: gateway.send })
    await flow.submit()
    const s = flow.state.get()
    expect(s.history.at(-1)).toBe("review")
    expect(s.failure).toBe("withdrawal.failed")
    expect(saved).toEqual([])
    expect(auth.open.size).toBe(0)
  })

  it("returns to the review with no failure when the passkey prompt is dismissed", async () => {
    const dismissed = new DOMException("dismissed", "NotAllowedError")
    const { flow } = harness(atReview(), { send: fakeGateway({ fail: dismissed }).send })
    await flow.submit()
    const s = flow.state.get()
    expect(s.history.at(-1)).toBe("review")
    expect(s.failure).toBeUndefined()
  })

  it("cancels a burn closed while it builds, before anything is burned", async () => {
    let release = () => {}
    const hold = new Promise<void>((resolve) => (release = resolve))
    const gateway = fakeGateway({ hold })
    const { flow, auth, closed } = harness(atReview(), { send: gateway.send })
    const submitting = flow.submit()
    expect(flow.state.get().stage).toBe("building")
    flow.close()
    release()
    await submitting
    expect(gateway.burned).toEqual([])
    expect(flow.state.get()).toMatchObject({ closed: true, stage: undefined })
    expect(closed()).toBe(1)
    expect(auth.open.size).toBe(0)
  })
})

/** At the review of 20 DAI to RECIPIENT on Base in USDC, its bridge quote read. */
async function atBridgeReview(over: Partial<WithdrawFlowDeps> = {}) {
  const initial: WithdrawState = {
    ...atReview(),
    route: { chainId: BASE, coin: "USDC" },
    review: { feeAtomic: undefined, changed: false },
  }
  const h = harness(initial, over)
  const ask = selectWithdrawQuote(initial, QUOTES, { wallet: WALLET }).bridgeAsk!
  const reviewed = await h.flow.bridgeQuote(ask).read()
  return { ...h, reviewed: reviewed.quote! }
}

/** What lands in USDC when `cost` DAI of 20 goes to the bridge. */
const landed = (cost: bigint) => (dai("20") - cost) / 10n ** BigInt(18 - USDC)

describe("openWithdrawFlow: bridge-out send", () => {
  it("burns the quote read at the send when it lands within the tolerance", async () => {
    const gateway = fakeGateway()
    const { flow, bridge, reviewed } = await atBridgeReview({ send: gateway.send })
    expect(reviewed.minReceived).toBe(landed(BRIDGE_COST))
    bridge.market.cost = dai("0.65")
    await flow.submit()
    const burned = gateway.burned[0]?.route
    expect(burned?.kind === "bridge" && burned.choice.quote.minReceived).toBe(landed(dai("0.65")))
    expect(flow.state.get().history.at(-1)).toBe("status")
  })

  it("burns nothing when the send's quote lands worse, and the review shows it as a changed fee", async () => {
    const gateway = fakeGateway()
    const { flow, bridge, auth } = await atBridgeReview({ send: gateway.send })
    bridge.market.cost = dai("1")
    await flow.submit()
    const s = flow.state.get()
    expect(gateway.burned).toEqual([])
    expect(s.history.at(-1)).toBe("review")
    expect(s.review).toMatchObject({ feeAtomic: dai("1"), changed: true })
    expect(s.bridge?.answer.quote?.minReceived).toBe(landed(dai("1")))
    expect(s.failure).toBeUndefined()
    expect(auth.open.size).toBe(0)
  })
})

describe("openWithdrawFlow: solve", () => {
  it("solves From for a typed To by pricing each guess on the bridge", async () => {
    const initial: WithdrawState = {
      ...withdrawInitial({ recipient: RECIPIENT, atAmount: true }, 1),
      route: { chainId: BASE, coin: "USDC" },
    }
    const { flow, bridge } = harness(initial)
    flow.typed("99.4", "to")
    await expect.poll(() => flow.state.get().solve?.tries).toBe(1)
    await expect.poll(() => bridge.asked.length).toBe(2)
    // The first guess is To plus the fixed fee; the second lands within a cent of To.
    expect(bridge.asked[0]).toBe(dai("99.5"))
    expect(flow.state.get().solve?.from).toBe(dai("100"))
  })
})
