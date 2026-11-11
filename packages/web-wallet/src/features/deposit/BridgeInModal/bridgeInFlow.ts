/**
 * The bridge-in sheet's flow: quotes for what is typed, the review, and the send that signs the
 * provider's approvals and then its bridge call on the origin chain.
 */
import { isAddressEqual, type Address, type Hex, type PublicClient } from "viem"
import { WalletError, bestEffort } from "@obsidion/core/errors"
import {
  memoryStore,
  upsertDepositL1WalletContact,
  type BridgeInPays,
  type BridgeInQuote,
  type BridgeInQuoteRequest,
  type BridgeIns,
  type Contacts,
  type DepositAdmission,
  type PortalCapacityStore,
  type QueryEntry,
  type ReadonlyStore,
} from "@obsidion/front-core"
import { showReportableError } from "../../../errors/errorModal"
import { isWalletRejection, type L1Wallet } from "../../../session/l1Wallet"
import type { ScreenFlow } from "../../../ui/useScreenFlow"
import { bridgeCharged, isUnreachable } from "../bridgeChains"
import { FundingPreflightError, runFundingPreflight, UNKNOWN_CAPACITY } from "../fundingPreflight"
import {
  bridgeInTransition,
  bridgeQuoteKey,
  quoteRefusal,
  type BridgeInEvent,
  type BridgeInFailure,
  type BridgeInState,
  type BridgeInStep,
} from "./bridgeInTransition"

/** How far the send's fresh quote may be worse than the review before the review shows it. */
export const REPRICE_PERCENT = 1n

/** The origin chain's reads a send waits on. */
export type OriginReader = Pick<PublicClient, "waitForTransactionReceipt" | "getTransactionCount">

export interface BridgeInDeps {
  l1Wallet: Pick<L1Wallet, "view" | "clients">
  /** The page's quote per request. */
  quote: (request: BridgeInQuoteRequest) => QueryEntry<BridgeInQuote>
  reader: (chainId: number) => OriginReader
  /** The deposit fee of the row for `token`, read now, decimal in its token. */
  depositFee: (token: string) => Promise<string>
  bridgeIns: Pick<BridgeIns, "start" | "markSent" | "apply">
  /** The saved wallets the origin wallet joins; none for a visitor. */
  contacts?: Pick<Contacts, "upsertL1WalletContact"> | null
  /** Wakes the tracker that follows the sent bridge-in. */
  track: () => void
  now: () => number
  initial: BridgeInState
  report?: typeof showReportableError
}

export interface BridgeInInputs {
  /** The bridge call's hash, once the wallet returns it. */
  onSent: (originTxHash: Hex) => void
}

/** What the review asks: its request, and the balance the quote must fit. */
export interface BridgeInReview {
  request: BridgeInQuoteRequest
  /** Typed in To: the review shows a quote taken now for exactly that amount. */
  fresh: boolean
  balance?: bigint
  /** A request pays its exact amount, so the bridge may pull up to its slippage. */
  fixed: boolean
}

/** What one Bridge in sends, as the review has it. */
export interface BridgeInSend {
  /** The key of the request the review shows. */
  key: string
  reviewed: BridgeInQuote
  /** The request the review was quoted for; the send asks it again for the real recipient. */
  request: BridgeInQuoteRequest
  /** A request lands exactly what it asks; a deposit sends exactly the review's From. */
  fixed: boolean
  balance?: bigint
  /** A fresh deposit address for this bridge-in. */
  recipient: () => Promise<Address | undefined>
  /** The record's units. */
  units: { symbol: string; inputDecimals: number; outputSymbol: string; outputDecimals: number }
  /** The bridge's fee in dollars, decimal, where it can be priced. */
  feeUsd: (quote: BridgeInQuote) => string | undefined
  /** Set when the bridge pays someone else's deposit address. */
  pays?: BridgeInPays
  walletName?: string
  /** The portal's answer for a quote: a refused one sends nothing. */
  admit: (quote: BridgeInQuote) => DepositAdmission
  /** The landing row's capacity bucket, once its key is known. */
  capacity?: PortalCapacityStore
  /** The deposit fee the review showed, decimal, and the row token it is read for. */
  depositFee: { shown: string; row: string }
}

export interface BridgeInFlow extends ScreenFlow {
  state: ReadonlyStore<BridgeInState>
  go(step: BridgeInStep): void
  type(side: "from" | "to", text: string, maxed?: boolean): void
  pickChain(chain: number, token?: string): void
  pickToken(token: string): void
  /** The page's quote for `request`; each answer the lookup reads is the one shown for it. */
  quote(request: BridgeInQuoteRequest): QueryEntry<BridgeInQuote>
  review(review: BridgeInReview): Promise<void>
  send(send: BridgeInSend): Promise<void>
}

const originOf = (r: BridgeInQuoteRequest) => `${r.originChainId}:${r.inputToken}`

export function openBridgeInFlow(deps: BridgeInDeps, latest: () => BridgeInInputs): BridgeInFlow {
  const { l1Wallet, bridgeIns, now } = deps
  const report = deps.report ?? showReportableError
  const state = memoryStore<BridgeInState>(deps.initial)
  const dispatch = (event: BridgeInEvent) => state.set(bridgeInTransition(state.get(), event))
  let ended = new AbortController().signal
  /** The bridge call's hash, once the wallet returns it: the sheet never sends again. */
  let bridged: Hex | undefined
  /** The newest review asked for; only its answer is kept. */
  let asked = 0

  /** Saves the sent bridge-in's hash and shows its status. Never throws. */
  const track = async (id: string, depositor: Address, hash: Hex, send: BridgeInSend) => {
    dispatch({ type: "sent", id })
    // The origin wallet joins the saved wallets, as a deposit's funder does.
    if (!send.pays && deps.contacts)
      void bestEffort(
        "unknown",
        upsertDepositL1WalletContact(deps.contacts, {
          address: depositor,
          walletName: send.walletName,
          lastUsedAt: now(),
        }),
      )
    latest().onSent(hash)
    try {
      await bridgeIns.markSent(id, hash)
      deps.track()
    } catch (e) {
      report(e, "deposit:bridge-in")
    }
  }

  return {
    state: state.readonly,
    start(signal) {
      ended = signal
      let account = l1Wallet.view.get().account
      const off = l1Wallet.view.subscribe(() => {
        const next = l1Wallet.view.get().account
        if (next === account) return
        account = next
        dispatch({ type: "depositor" })
      })
      signal.addEventListener("abort", off)
    },
    go: (step) => dispatch({ type: "go", step }),
    type: (side, text, maxed) => dispatch({ type: "typed", side, text, maxed }),
    pickChain: (chain, token) => dispatch({ type: "chain", chain, token }),
    pickToken: (token) => dispatch({ type: "token", token }),
    quote(request) {
      const entry = deps.quote(request)
      const key = bridgeQuoteKey(request)
      return {
        name: entry.name,
        get: () => entry.get(),
        subscribe: (listener) => entry.subscribe(listener),
        refresh: () => entry.refresh(),
        async read(signal) {
          try {
            const quote = await entry.read(signal)
            if (!signal?.aborted)
              dispatch({ type: "priced", key, origin: originOf(request), quote })
            return quote
          } catch (e) {
            if (!signal?.aborted) dispatch({ type: "refused", key, refusal: quoteRefusal(e) })
            throw e
          }
        },
      }
    },
    async review({ request, fresh, balance, fixed }) {
      if (!fresh) return dispatch({ type: "go", step: "progress" })
      const id = ++asked
      const key = bridgeQuoteKey(request)
      dispatch({ type: "reviewing", on: true })
      try {
        const quote = await deps.quote(request).read(ended)
        if (id !== asked || ended.aborted) return
        const fits = balance === undefined || bridgeCharged(quote, fixed) <= balance
        dispatch({ type: "reviewed", key, origin: originOf(request), quote, fits })
      } catch (e) {
        if (id !== asked || ended.aborted) return
        dispatch({ type: "refused", key, refusal: quoteRefusal(e) })
        dispatch({ type: "reviewing", on: false })
      }
    },
    async send(send) {
      const { reviewed, request, fixed, balance } = send
      const account = request.depositor
      const admission = send.admit(reviewed)
      if (bridged || state.get().sending || admission.problem) return
      dispatch({ type: "sending", from: account })
      let started: string | undefined
      let failure: BridgeInFailure | undefined
      try {
        // A new capacity read and fee before an address is taken or the wallet is asked.
        await runFundingPreflight({
          store: send.capacity,
          required: admission.required,
          unknownCapacity: UNKNOWN_CAPACITY,
          shownFee: send.depositFee.shown,
          freshFee: await deps.depositFee(send.depositFee.row),
        })
        const to = await send.recipient()
        if (!to) return
        const charged = bridgeCharged(reviewed, fixed)
        // A deposit sends exactly the review's From, a request lands exactly its amount.
        const sendRequest: BridgeInQuoteRequest = {
          originChainId: request.originChainId,
          inputToken: request.inputToken,
          destinationChainId: request.destinationChainId,
          outputToken: request.outputToken,
          outputSymbol: request.outputSymbol,
          depositor: account,
          recipient: to,
          ...(fixed
            ? { outputAmount: request.outputAmount! }
            : { inputAmount: reviewed.inputAmount }),
        }
        const quoteSend = () => deps.quote(sendRequest).read(ended)
        // A fresh quote the portal refuses goes back to the review, which says why.
        const worse = (q: BridgeInQuote) =>
          !!send.admit(q).problem ||
          q.maxInputAmount * 100n > charged * (100n + REPRICE_PERCENT) ||
          (!fixed && q.outputAmount * 100n < reviewed.outputAmount * (100n - REPRICE_PERCENT)) ||
          (balance !== undefined && q.maxInputAmount > balance)
        const reprice = (quote: BridgeInQuote) =>
          dispatch({ type: "repriced", key: send.key, quote })
        let fresh = await quoteSend()
        if (worse(fresh)) return reprice(fresh)
        const chainId = request.originChainId
        const { walletClient, chain } = await l1Wallet.clients(chainId, account)
        const reader = deps.reader(chainId)
        let call = fresh.txs.at(-1)
        if (!call) return
        const approvals = fresh.txs.slice(0, -1)
        // Approvals move nothing: each one lands before the next.
        for (const tx of approvals) {
          const hash = await walletClient.sendTransaction({
            account,
            chain,
            to: tx.to,
            data: tx.data,
            value: tx.value,
          })
          const receipt = await reader.waitForTransactionReceipt({ hash })
          if (receipt.status !== "success")
            throw new WalletError("tx.failed", `Approval ${hash} reverted`)
        }
        // The bridge call reverts about a minute after its quote: the approvals' time is not spent
        // from it. Its own approvals are ignored, as the ones just granted cover it.
        if (approvals.length > 0) {
          const approved = fresh
          fresh = await quoteSend()
          call = fresh.txs.at(-1)
          if (
            !call ||
            worse(fresh) ||
            fresh.maxInputAmount > approved.maxInputAmount ||
            !isAddressEqual(call.to, approved.txs.at(-1)!.to)
          )
            return reprice(fresh)
        }
        // Lets the tracker find the call by its nonce should its hash never come back.
        const nonceHint = await reader.getTransactionCount({
          address: account,
          blockTag: "pending",
        })
        const feeUsd = send.feeUsd(fresh)
        started = (
          await bridgeIns.start({
            originChainId: chainId,
            depositor: account,
            recipient: to,
            ...send.units,
            quote: fresh,
            ...(feeUsd !== undefined && { feeUsd }),
            nonceHint,
            startTime: now(),
            ...(send.pays && { pays: send.pays }),
          })
        ).id
        const hash = await walletClient.sendTransaction({
          account,
          chain,
          to: call.to,
          data: call.data,
          value: call.value,
        })
        bridged = hash
        await track(started, account, hash, send)
      } catch (e) {
        // Nothing left the wallet: the record ends here rather than at its quote's expiry.
        if (started && !bridged && isWalletRejection(e))
          void bestEffort("unknown", bridgeIns.apply(started, [{ type: "dropped", at: now() }]))
        if (e instanceof FundingPreflightError)
          failure = e.reason === "capacity" ? "capacity" : "fee-changed"
        else if (isUnreachable(e)) failure = "unreachable"
        else if (!isWalletRejection(e) && !ended.aborted) report(e, "deposit:bridge-in")
      } finally {
        dispatch({ type: "stopped", failure })
      }
    },
  }
}
