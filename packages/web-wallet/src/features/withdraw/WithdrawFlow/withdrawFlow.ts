import { getAddress } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { bestEffort } from "@obsidion/core/errors"
import {
  memoryStore,
  upsertSavedL1WalletContact,
  type AddressScreener,
  type QueryEntry,
  type QueryState,
  type ReadonlyStore,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import type { BridgeOutToken } from "@obsidion/sdk"
import { showReportableError } from "../../../errors/errorModal"
import { amountBucket, failureCode, fireEvent, lapTimer } from "../../../lib/analytics"
import type { L1Wallet } from "../../../session/l1Wallet"
import { ETHERFI_PROVIDER, type SavedL1Wallet } from "../../../session/savedL1Wallets"
import type { Session } from "../../../session/session"
import type { WithdrawFlowEntry } from "../../../session/routeStates"
import type { useProvingOutcome } from "../../../ui/hooks"
import type { OperationHandOffHandle } from "../../operations/OperationHandOff"
import { failureCodeOf } from "../../operations/operations"
import { submitBridgeOut } from "../bridgeOut"
import {
  answerFloor,
  bridgeOutDecimals,
  bridgeOutSendable,
  type BridgeOutAnswer,
  type BridgeOutAsk,
} from "../bridgeOutQuote"
import { recordBurnDuration } from "../burnTiming"
import { ETHERFI_CONTACT_NAME, saveEtherfiAddress } from "../etherfi"
import { submitFreshAddressWithdrawal } from "../freshAddressGateway"
import {
  submitSponsoredWithdrawal,
  type WithdrawDeps,
  type WithdrawStage,
} from "../withdrawGateway"
import type { SwapQuote } from "../withdrawQuote"
import { ACTIVE_SOURCE, type SwapKey } from "../swapQuotes"
import {
  CENT,
  bridgeFee,
  bridgeKey,
  feeRoute,
  floorRoute,
  selectWithdrawQuote,
  type Chosen,
  type WithdrawBalance,
  type WithdrawPlan,
  type WithdrawQuoteView,
  type WithdrawQuotes,
  type WithdrawStep,
} from "../withdrawQuoteView"
import type { WithdrawalSpeed } from "../WithdrawalSpeedPicker"
import type { WithdrawalReceiveAsset } from "../withdrawAssets"
import { connectedRecipient } from "./walletRecipient"
import type { WithdrawStart } from "./withdrawStart"
import { withdrawTransition, type WithdrawEvent, type WithdrawState } from "./withdrawTransition"

/** What a submitted withdrawal's record tells the flow. */
export type SentRecord = Pick<WithdrawalRecord, "localId" | "phase" | "rawAmount" | "tokenDecimals">

export interface WithdrawFlowDeps {
  initial: WithdrawState
  /** A start's passkey prompt, in place of a live burn's hand-off. */
  signing?: ReadonlyStore<boolean>
  /** Sends the plan through its gateway. */
  send(
    plan: WithdrawPlan,
    screener: AddressScreener,
    onStage: (stage: WithdrawStage) => void,
  ): Promise<SentRecord>
  auth: { beginSigning(): AbortController; endSigning(window: AbortController): void }
  /** Saves the recipient as a contact; absent for a visitor. */
  saveRecipient?: (plan: WithdrawPlan, etherfi: boolean) => Promise<unknown>
  saveEtherfi?: (address: `0x${string}`, previous?: `0x${string}`) => Promise<unknown>
  recordBurn(ms: number): Promise<unknown>
  l1Wallet: Pick<L1Wallet, "connectAnother" | "view">
  bridgeOutQuote: (ask: BridgeOutAsk) => QueryEntry<BridgeOutAnswer>
  swapQuote: (key: SwapKey) => QueryEntry<SwapQuote>
}

/** What the flow reads from the latest render. */
export interface WithdrawInputs {
  view: WithdrawQuoteView
  quotes: WithdrawQuotes
  balance: WithdrawBalance
  screener: AddressScreener
  /** The name of the network the withdrawal lands on. */
  network: string
  /** The recipient is an ether.fi Cash address, which saves as ether.fi. */
  etherfiCash: boolean
  saved: readonly SavedL1Wallet[]
  outcome: ReturnType<typeof useProvingOutcome>
  handOff: { current: OperationHandOffHandle | null }
  /** The connect picker's opener, and whether it is up. */
  openPicker: () => void | Promise<void>
  pickerShown: () => boolean
  onClose: () => void
}

/** The flow's opening state, from its entry and its start. */
export function withdrawInitial(
  entry: WithdrawFlowEntry,
  l1ChainId: number,
  start?: WithdrawStart,
): WithdrawState {
  const atAmount = !!entry.atAmount && !!entry.recipient
  const first: WithdrawStep = entry.start ?? "address"
  return {
    history: start?.history ?? (atAmount ? [first, "amount"] : [first]),
    chosen:
      start?.chosen ?? (atAmount ? { recipient: entry.recipient!, name: entry.name } : undefined),
    route: {
      chainId: start?.chainId ?? entry.startChainId ?? l1ChainId,
      coin: start?.coin ?? "DAI",
    },
    amount: { text: start?.amount ?? "", side: start?.side ?? "from", maxed: !!start?.maxed },
    gasAtomic: start?.gasAtomic ?? 5n * 10n ** BigInt(DEFAULT_DECIMALS),
    speed: start?.speed,
    review: { feeAtomic: undefined, changed: !!start?.feeChanged },
    sent: start?.sent,
    stage: start?.stage,
    signing: false,
    live: false,
    closed: false,
  }
}

/** The gateway a plan's route takes. */
export function sendPlan(session: Session) {
  return (
    plan: WithdrawPlan,
    screener: AddressScreener,
    onStage: (stage: WithdrawStage) => void,
  ): Promise<WithdrawalRecord> => {
    const deps: WithdrawDeps = { screener, session }
    const { route } = plan
    const recipient = { recipient: plan.recipient, recipientAlias: plan.name }
    if (route.kind === "bridge")
      return submitBridgeOut(
        deps,
        { ...route.choice, ...recipient, amountAtomic: plan.burnAtomic, proverTip: plan.proverTip },
        onStage,
      )
    if (plan.fresh)
      return submitFreshAddressWithdrawal(
        deps,
        {
          ...recipient,
          amountAtomic: plan.amountAtomic,
          burnAtomic: plan.burnAtomic,
          gasAtomic: plan.gasAtomic,
          fundsAsset: plan.coin,
          quote: route.quote,
        },
        onStage,
      )
    return submitSponsoredWithdrawal(
      deps,
      plan.recipient,
      plan.burnAtomic,
      onStage,
      plan.name,
      plan.coin,
      route.kind === "swap" ? route.quote : undefined,
      plan.proverTip,
    )
  }
}

/** The flow's services from the session it runs in. */
export function withdrawFlowDeps(
  session: Session,
  initial: WithdrawState,
  signing?: ReadonlyStore<boolean>,
): WithdrawFlowDeps {
  const { contacts, page } = session
  return {
    initial,
    signing,
    send: sendPlan(session),
    auth: session.auth,
    saveRecipient: contacts
      ? (plan, etherfi) =>
          upsertSavedL1WalletContact(contacts, {
            address: plan.recipient,
            name: etherfi ? plan.name ?? ETHERFI_CONTACT_NAME : plan.name,
            provider: etherfi ? ETHERFI_PROVIDER : undefined,
          })
      : undefined,
    saveEtherfi: contacts
      ? (address, previous) => saveEtherfiAddress(contacts, address, previous)
      : undefined,
    recordBurn: (ms) => recordBurnDuration(session.burnDurations, ms),
    l1Wallet: page.l1Wallet,
    bridgeOutQuote: page.bridgeOutQuote,
    swapQuote: page.swapQuote,
  }
}

const abs = (n: bigint) => (n < 0n ? -n : n)
const same = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

/**
 * The withdraw modal's flow: its steps, the amount and route, the To→From solve, the review's fee
 * check, the burn and its cancel, and the wallet a connect brings in.
 */
export function openWithdrawFlow(deps: WithdrawFlowDeps, latest: () => WithdrawInputs) {
  const state = memoryStore<WithdrawState>(deps.initial)
  const s = () => state.get()
  const dispatch = (event: WithdrawEvent) => state.set(withdrawTransition(s(), event))
  let shown: AbortSignal | undefined
  /** The solve pricing its guesses; answers meanwhile are its own, or for a guess it left. */
  let solving: AbortController | undefined
  let ceremony: AbortController | undefined
  let cancel: AbortController | undefined
  /** Stops waiting on a wallet the picker connects. */
  let following: (() => void) | undefined

  /** A To the fee moved under is solved again. */
  const resolveIfMoved = (fee: bigint) => {
    const { amount, solve } = s()
    if (solving || amount.side !== "to" || !solve) return
    if (solve.fee === undefined || abs(fee - solve.fee) > CENT)
      void bestEffort("unknown", solveTo())
  }

  /** What From lands and costs on the current route, priced afresh. */
  const price = async (
    view: WithdrawQuoteView,
    from: bigint,
    signal: AbortSignal,
  ): Promise<{ received: bigint; fee: bigint } | undefined> => {
    const { onL1, route, coin, chainId, pricedTip, toDecimals } = view
    if (!onL1) {
      if (!route) return undefined
      const ask = {
        provider: route.provider,
        l2Token: route.l2Token,
        chainId,
        token: coin as BridgeOutToken,
        amount: from,
        proverTip: pricedTip,
      }
      const answer = await deps.bridgeOutQuote(ask).read(signal)
      if (!answer.quote) return undefined
      return { received: answer.quote.minReceived, fee: bridgeFee(from, answer.quote, toDecimals) }
    }
    if (view.direct) {
      const fee = view.feeAtomic
      return fee === undefined || from <= fee ? undefined : { received: from - fee, fee }
    }
    const quote = await deps
      .swapQuote({
        source: ACTIVE_SOURCE,
        output: coin,
        amountAtomic: from,
        recipient: s().chosen?.recipient,
        proverTip: pricedTip,
        daiForGas: 0n,
      })
      .read(signal)
    return quote.estimate && { received: quote.estimate.amountOut, fee: quote.fee.floorAtomic }
  }

  /** Re-prices From until what lands is within a cent of the typed To, at most twice. */
  async function solveTo() {
    solving?.abort()
    const run = (solving = new AbortController())
    try {
      await solveGuesses(run.signal)
    } finally {
      if (solving === run) solving = undefined
    }
  }

  async function solveGuesses(signal: AbortSignal) {
    const { quotes, balance } = latest()
    const view = selectWithdrawQuote(s(), quotes, balance)
    const to = view.typedAtomic
    if (s().amount.side !== "to" || !to) return
    let from = view.guessFrom(to)
    dispatch({ type: "priced", solve: { from, tries: 0, fee: view.feeAtomic } })
    for (let tries = 0; tries < 2; tries++) {
      let priced: Awaited<ReturnType<typeof price>>
      try {
        priced = await price(view, from, signal)
      } catch (e) {
        if (signal.aborted) return
        throw e
      }
      if (signal.aborted || !priced || priced.received === 0n) return
      const miss = to - priced.received
      // Stablecoins convert one to one; ETH at the rate the quote just gave.
      const missDai =
        view.coin === "ETH"
          ? (miss * (from - priced.fee)) / priced.received
          : miss * 10n ** BigInt(DEFAULT_DECIMALS - view.toDecimals)
      if (abs(missDai) <= CENT) {
        dispatch({ type: "priced", solve: { from, tries, fee: priced.fee } })
        return
      }
      from = from + missDai > 0n ? from + missDai : 1n
      dispatch({ type: "priced", solve: { from, tries: tries + 1, fee: priced.fee } })
    }
  }
  const solve = () => void bestEffort("unknown", solveTo())

  /** A bridge answer for `ask`, kept with its floor, and its fee when it prices From itself. */
  const bridgePriced = (ask: BridgeOutAsk, answer: BridgeOutAnswer) => {
    const { view } = latest()
    const decimals = bridgeOutDecimals(ask.token, ask.chainId)
    // A probe under the fixed fees only names the floor.
    const own = answer.quote && ask.amount === view.fundsAtomic
    const fee = own ? bridgeFee(ask.amount, answer.quote, decimals) : undefined
    dispatch({
      type: "priced",
      bridge: {
        key: bridgeKey(ask),
        floorRoute: floorRoute(ask.chainId, ask.token, ask.proverTip),
        floor: answerFloor(answer),
        answer,
        ...(fee !== undefined && { fee: { route: feeRoute(ask.chainId, ask.token), fee } }),
      },
      fee,
    })
    if (fee !== undefined) resolveIfMoved(fee)
  }
  const reviewed = new WeakMap<
    QueryEntry<BridgeOutAnswer>,
    ReadonlyStore<QueryState<BridgeOutAnswer>>
  >()

  /**
   * The plan a send burns: a bridge-out's quote read again now. A worse one goes back to the review
   * with its figures, and nothing is burned.
   */
  const sendable = async (
    plan: WithdrawPlan,
    view: WithdrawQuoteView,
    signal: AbortSignal,
  ): Promise<WithdrawPlan | undefined> => {
    const { route } = plan
    if (route.kind !== "bridge" || !view.route) return plan
    const { choice } = route
    const ask: BridgeOutAsk = {
      provider: view.route.provider,
      l2Token: view.route.l2Token,
      chainId: choice.chain.chainId,
      token: choice.token,
      amount: plan.burnAtomic,
      proverTip: plan.proverTip,
    }
    const entry = deps.bridgeOutQuote(ask)
    entry.refresh()
    const fresh = await entry.read(signal)
    const quote = bridgeOutSendable(choice.quote, fresh)
    if (quote) return { ...plan, route: { kind: "bridge", choice: { ...choice, quote } } }
    dispatch({ type: "cancelled" })
    bridgePriced(ask, fresh)
    return undefined
  }

  const observed = new WeakMap<QueryEntry<SwapQuote>, ReadonlyStore<QueryState<SwapQuote>>>()
  /** A live swap quote answered on `output`'s route. */
  const swapPriced = (output: WithdrawalReceiveAsset, fee: bigint) => {
    const { view, quotes } = latest()
    dispatch({
      type: "priced",
      fee,
      ...(view.gasAtomic === 0n && { lastFee: { route: feeRoute(quotes.l1ChainId, output), fee } }),
    })
    resolveIfMoved(fee)
  }

  /** The connected wallet, as the recipient on the amount step. */
  const land = (account: string, walletName: string | null) => {
    if (s().history.at(-1) !== "amount") return
    dispatch({ type: "choose", chosen: connectedRecipient(account, latest().saved, walletName) })
  }

  return {
    state: state.readonly,
    start(started: AbortSignal) {
      shown = started
      started.addEventListener("abort", () => {
        solving?.abort()
        following?.()
      })
      const prompt = deps.signing
      if (prompt) {
        const follow = () => !s().live && dispatch({ type: "signing", signing: prompt.get() })
        follow()
        const off = prompt.subscribe(follow)
        started.addEventListener("abort", off)
      }
      if (s().amount.side === "to") solve()
    },

    /** The bridge quote a view reads: every answer is kept through `priced`. */
    bridgeQuote(ask: BridgeOutAsk): QueryEntry<BridgeOutAnswer> {
      const entry = deps.bridgeOutQuote(ask)
      return {
        ...entry,
        read: async (readSignal) => {
          const answer = await entry.read(readSignal)
          bridgePriced(ask, answer)
          return answer
        },
      }
    },

    /** The review's bridge quote: each answer its poll brings is kept through `priced`. */
    bridgeReview(ask: BridgeOutAsk): ReadonlyStore<QueryState<BridgeOutAnswer>> {
      const entry = deps.bridgeOutQuote(ask)
      const known = reviewed.get(entry)
      if (known) return known
      const store: ReadonlyStore<QueryState<BridgeOutAnswer>> = {
        get: () => entry.get(),
        subscribe(listener) {
          let seen: BridgeOutAnswer | undefined
          const check = () => {
            const state = entry.get()
            if (state.status !== "ready" || state.value === seen) return
            seen = state.value
            bridgePriced(ask, state.value)
          }
          check()
          return entry.subscribe(() => {
            check()
            listener()
          })
        },
      }
      reviewed.set(entry, store)
      return store
    },

    /** The burn's live swap quote a view reads: each answer's fee is what the review checks. */
    swapQuote(key: SwapKey): ReadonlyStore<QueryState<SwapQuote>> {
      const entry = deps.swapQuote(key)
      const known = observed.get(entry)
      if (known) return known
      const store: ReadonlyStore<QueryState<SwapQuote>> = {
        get: () => entry.get(),
        subscribe(listener) {
          let seen: SwapQuote | undefined
          const check = () => {
            const state = entry.get()
            if (state.status !== "ready" || state.value === seen) return
            seen = state.value
            swapPriced(key.output, state.value.fee.floorAtomic)
          }
          check()
          return entry.subscribe(() => {
            check()
            listener()
          })
        },
      }
      observed.set(entry, store)
      return store
    },

    go(step: WithdrawStep) {
      dispatch({
        type: "go",
        step,
        ...(step === "gas" && { gasAtomic: latest().view.defaultGasAtomic }),
      })
    },
    back() {
      dispatch({ type: "back" })
    },
    enterReview() {
      dispatch({ type: "enterReview", feeAtomic: latest().view.reviewFeeAtomic })
    },
    choose(chosen: Chosen, then?: WithdrawStep) {
      dispatch({ type: "choose", chosen, then })
    },
    /** The ether.fi step's address, saved first when asked. */
    chooseEtherfi(
      address: `0x${string}`,
      opts: { save: boolean; unsaved: boolean; previous?: `0x${string}` },
    ) {
      if (opts.save && deps.saveEtherfi)
        void bestEffort("unknown", deps.saveEtherfi(address, opts.previous))
      dispatch({
        type: "choose",
        chosen: {
          recipient: address,
          name: ETHERFI_CONTACT_NAME,
          etherfi: true,
          unsaved: opts.unsaved,
        },
        then: "amount",
      })
    },
    typed(text: string, side: "from" | "to") {
      dispatch({ type: "typed", text, side })
      if (side === "to") solve()
    },
    max() {
      dispatch({ type: "max" })
    },
    route(chainId: number, coin: WithdrawalReceiveAsset) {
      dispatch({ type: "route", chainId, coin })
      if (s().amount.side === "to") solve()
    },
    gas(gasAtomic: bigint) {
      dispatch({ type: "gas", gasAtomic })
    },
    speed(speed: WithdrawalSpeed) {
      dispatch({ type: "speed", speed })
    },
    /** The passkey beat of a live burn's hand-off. */
    beat(beat: OperationHandOffHandle["beat"]) {
      dispatch({ type: "signing", signing: beat !== "proving" })
    },
    solve,

    /** Connects a wallet from the address step; resolves with it, or undefined. */
    connectWallet() {
      const { openPicker, pickerShown } = latest()
      return deps.l1Wallet.connectAnother(openPicker, pickerShown, shown)
    },
    /**
     * The wallet picker closed on a change: a switched account becomes the recipient at once,
     * and another wallet once it connects while the picker is up.
     */
    walletPicked() {
      following?.()
      const from = s().chosen?.recipient
      const fresh = () => {
        const { account, walletName, connecting, reopening } = deps.l1Wallet.view.get()
        if (account && !same(account, from)) {
          stop()
          land(account, walletName)
        } else if (!connecting && !reopening && !latest().pickerShown()) stop()
      }
      const off = deps.l1Wallet.view.subscribe(fresh)
      const stop = () => {
        off()
        following = undefined
      }
      following = stop
      fresh()
    },
    pickSaved(wallet: SavedL1Wallet, etherfi: boolean) {
      dispatch({
        type: "choose",
        chosen: { recipient: getAddress(wallet.address), name: wallet.name, etherfi },
      })
    },

    /** Burns the review's plan: the signing window, the gateway, then the contact save. */
    async submit() {
      const { view } = latest()
      const plan = view.plan()
      if (!plan || s().stage) return
      const { screener, network, etherfiCash, outcome } = latest()
      const unsaved = !!s().chosen?.unsaved
      const context = plan.route.kind === "bridge" ? "withdraw:bridge-out" : "withdraw:submit"
      const cancelled = (cancel = new AbortController())
      const signingWindow = (ceremony = deps.auth.beginSigning())
      dispatch({ type: "submitted", plan, chain: network })
      outcome.start("building")
      fireEvent("withdraw_confirmed")
      const elapsed = lapTimer()
      const onStage = (stage: WithdrawStage) => {
        // Only here: past `proving` the burn may be away, and a cancel would drop its record.
        if (stage === "proving" && cancelled.signal.aborted) throw cancelled.signal.reason
        outcome.updateStage(stage)
        dispatch({ type: "staged", stage })
      }
      try {
        const burning = await sendable(plan, view, cancelled.signal)
        if (!burning) {
          outcome.cancel()
          return
        }
        const record = await deps.send(burning, screener, onStage)
        outcome.finish()
        // `submitting`: sent, receipt pending. Only a mined burn's duration spans confirm to mine.
        const mined = record.phase !== "submitting"
        const durationMs = elapsed()
        if (mined && plan.route.kind !== "bridge")
          void bestEffort("unknown", deps.recordBurn(durationMs))
        fireEvent("withdraw_submitted", {
          duration_ms: mined ? durationMs : undefined,
          amount_bucket: amountBucket(BigInt(record.rawAmount ?? 0), record.tokenDecimals),
        })
        // A Cash address saves as ether.fi, so the next visit knows it.
        if (plan.route.kind !== "bridge" && !unsaved && deps.saveRecipient)
          void bestEffort("unknown", deps.saveRecipient(plan, etherfiCash))
        dispatch({ type: "staged", stage: undefined, localId: record.localId })
      } catch (e) {
        if (cancelled.signal.aborted || isPasskeyCancelled(e)) {
          outcome.cancel()
          if (!s().closed) dispatch({ type: "cancelled" })
          return
        }
        outcome.finish()
        fireEvent("action_failed", { action: context, code: failureCode(e) })
        if (s().closed) return
        showReportableError(e, context)
        dispatch({ type: "failed", code: failureCodeOf(e) })
      } finally {
        deps.auth.endSigning(signingWindow)
        ceremony = undefined
        cancel = undefined
        dispatch({ type: "staged", stage: undefined })
      }
    },

    /** Closing while the burn builds cancels it; once it proves, the bell carries it. */
    close() {
      const { handOff, outcome, onClose } = latest()
      // Only the prompt this burn holds open; it rejects as a passkey cancel.
      if (handOff.current?.beat === "signing") ceremony?.abort()
      const { stage } = s()
      if (stage === "building") cancel?.abort()
      else if (stage) {
        handOff.current?.leave()
        outcome.finish()
      }
      dispatch({ type: "closed" })
      onClose()
    },

    /** From a failed status, back to the amount. */
    retry() {
      dispatch({ type: "back", to: "amount" })
    },
  }
}

export type WithdrawFlow = ReturnType<typeof openWithdrawFlow>
