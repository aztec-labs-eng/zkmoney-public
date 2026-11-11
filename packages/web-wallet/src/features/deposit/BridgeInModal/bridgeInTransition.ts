/** The bridge-in sheet's state: its step, the origin picked, the amount, and the quote shown. */
import type { Address } from "viem"
import { WalletError, type ErrorCode } from "@obsidion/core/errors"
import type { BridgeInQuote, BridgeInQuoteRequest } from "@obsidion/front-core"
import { bridgeBelowFee } from "../bridgeChains"
import type { BridgeInStart } from "../depositStart"

export type BridgeInStep = "amount" | "chain" | "token" | "progress" | "status"

/**
 * Why a send stopped before the wallet was asked: an RPC that refused or never answered, capacity
 * known not to take the deposit, or a deposit fee that moved since the review.
 */
export type BridgeInFailure = "unreachable" | "capacity" | "fee-changed"

/** What was typed, and in which field: the other follows from the quote. MAX sticks until edited. */
export interface BridgeInAmount {
  text: string
  side: "from" | "to"
  maxed: boolean
}

/** A quote the provider refused. */
export interface QuoteRefusal {
  code: ErrorCode
  /** A `bridge.belowFee` refusal's amount and fee, base units of the origin coin. */
  below?: { amount: bigint; fee: bigint }
}

/** The answer for one request: a quote, or the provider's refusal. */
export type HeldQuote =
  | { key: string; answer: BridgeInQuote; refusal?: undefined }
  | { key: string; answer?: undefined; refusal: QuoteRefusal }

export interface BridgeInState {
  step: BridgeInStep
  /** The origin picked on the sheet; a flow above it picks for it instead. */
  chain?: number
  token?: string
  amount: BridgeInAmount
  /** The answer shown for the request keyed `key`: the lookup's, a review's or a send's. */
  quote?: HeldQuote
  /** The last quote per origin, its fee shown faded while the next one is out. */
  held?: { origin: string; quote: BridgeInQuote }
  /**
   * The quote a typed To converts through on a route that swaps on the origin chain: the last one
   * held when To was typed, else the first for the origin after. Kept until To is typed again.
   */
  rate?: { origin: string; quote: BridgeInQuote }
  /** The send's fresh quote came back worse than the review: the review shows it instead. */
  repriced: boolean
  reviewing: boolean
  /** The wallet is asked to approve the bridge call. */
  sending: boolean
  /** The depositor a send started from, kept once bridged, whatever the wallet switches to. */
  sentFrom?: Address
  /** The bridge-in this sheet sent: its `bridgeIns` record. */
  sent?: string
  /** Why the last send stopped; shown until the amount changes. */
  failure?: BridgeInFailure
}

export type BridgeInEvent =
  | { type: "go"; step: BridgeInStep }
  | { type: "typed"; side: "from" | "to"; text: string; maxed?: boolean }
  | { type: "chain"; chain: number; token?: string }
  | { type: "token"; token: string }
  /** An answer for `key`, read for `origin`. */
  | { type: "priced"; key: string; origin: string; quote: BridgeInQuote; reviewed?: boolean }
  | { type: "refused"; key: string; refusal: QuoteRefusal }
  | { type: "reviewing"; on: boolean }
  /** The review's quote: the review opens where it fits the balance. */
  | { type: "reviewed"; key: string; origin: string; quote: BridgeInQuote; fits: boolean }
  | { type: "sending"; from: Address }
  /** The send's fresh quote is worse than the review: the review shows it. */
  | { type: "repriced"; key: string; quote: BridgeInQuote }
  | { type: "sent"; id: string }
  | { type: "stopped"; failure?: BridgeInFailure }
  /** Another depositor needs its own quote and balance: a review goes back to the amount. */
  | { type: "depositor" }

export function bridgeInStart(
  start: BridgeInStart | undefined,
  {
    chain,
    token,
    carried,
    fixed,
  }: {
    chain?: number
    token?: string
    carried?: { amount: string; side: "from" | "to" }
    fixed?: string
  },
): BridgeInState {
  return {
    step: start?.step ?? "amount",
    chain,
    token,
    amount: {
      text: fixed ?? carried?.amount ?? "",
      side: fixed === undefined ? carried?.side ?? "from" : "from",
      maxed: false,
    },
    repriced: false,
    reviewing: false,
    sending: start?.sending ?? false,
    sent: start?.sent,
  }
}

export function bridgeInTransition(s: BridgeInState, e: BridgeInEvent): BridgeInState {
  switch (e.type) {
    case "go":
      return { ...s, step: e.step }
    case "typed":
      return {
        ...s,
        amount: { text: e.text, side: e.side, maxed: e.maxed ?? false },
        rate: e.side === "to" ? s.held : undefined,
        failure: undefined,
      }
    case "chain":
      return { ...s, chain: e.chain, token: e.token ?? s.token, step: "token" }
    case "token":
      return { ...s, token: e.token, step: "amount" }
    case "priced":
      return {
        ...s,
        quote: { key: e.key, answer: e.quote },
        held: { origin: e.origin, quote: e.quote },
        ...rateFor(s, e),
      }
    case "refused":
      return { ...s, quote: { key: e.key, refusal: e.refusal } }
    case "reviewing":
      return { ...s, reviewing: e.on, ...(e.on && { repriced: false }) }
    case "reviewed":
      return {
        ...s,
        reviewing: false,
        quote: { key: e.key, answer: e.quote },
        held: { origin: e.origin, quote: e.quote },
        ...rateFor(s, e),
        // Grown past the balance, the amount step shows it short.
        step: e.fits ? "progress" : s.step,
      }
    case "sending":
      return { ...s, sending: true, sentFrom: e.from, repriced: false, failure: undefined }
    case "repriced":
      return { ...s, quote: { key: e.key, answer: e.quote }, repriced: true }
    case "sent":
      return { ...s, sent: e.id, step: "status" }
    case "stopped":
      // Never bridged: the wallet the sheet sends from is the connected one again. Changed
      // capacity is reviewed on the amount step.
      return {
        ...s,
        sending: false,
        failure: e.failure,
        sentFrom: s.sent ? s.sentFrom : undefined,
        ...(e.failure === "capacity" && !s.sent && { step: "amount" }),
      }
    case "depositor":
      return s.step === "progress" && !s.sending && !s.sent ? { ...s, step: "amount" } : s
  }
}

/** A quote for an origin the rate is not from becomes the rate while To is typed. */
const rateFor = (s: BridgeInState, e: { origin: string; quote: BridgeInQuote }) =>
  s.amount.side === "to" && s.rate?.origin !== e.origin
    ? { rate: { origin: e.origin, quote: e.quote } }
    : {}

/** A quote request's key: two requests for the same quote share it. */
export const bridgeQuoteKey = (r: BridgeInQuoteRequest) =>
  [
    r.originChainId,
    r.inputToken,
    r.destinationChainId,
    r.outputToken,
    r.inputAmount !== undefined ? `in:${r.inputAmount}` : `out:${r.outputAmount}`,
    r.depositor,
    r.recipient,
  ].join(":")

/** The provider's refusal of a quote, from the error its read threw. */
export function quoteRefusal(e: unknown): QuoteRefusal {
  const below = bridgeBelowFee(e)
  return {
    code: e instanceof WalletError ? e.code : "bridge.quoteFailed",
    ...(below && { below }),
  }
}
