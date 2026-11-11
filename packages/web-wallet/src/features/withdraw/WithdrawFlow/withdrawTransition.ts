import type { ErrorCode } from "@obsidion/core/errors"
import type { BridgeOutAnswer } from "../bridgeOutQuote"
import type { WithdrawalSpeed } from "../WithdrawalSpeedPicker"
import type { WithdrawStage } from "../withdrawGateway"
import type { WithdrawalReceiveAsset } from "../withdrawAssets"
import type {
  Chosen,
  WithdrawPlan,
  WithdrawQuoteState,
  WithdrawSolve,
  WithdrawStep,
} from "../withdrawQuoteView"

/** The withdrawal sent from the review, and its record's id once the gateway answers. */
export interface WithdrawSent {
  plan: WithdrawPlan
  chain: string
  localId?: string
}

export interface WithdrawState extends WithdrawQuoteState {
  history: WithdrawStep[]
  /** The fee the review was entered with, and whether it has moved since. */
  review: { feeAtomic?: bigint; changed: boolean }
  sent?: WithdrawSent
  /** Set while the gateway runs. */
  stage?: WithdrawStage
  /** The passkey prompt is up, or about to be. */
  signing: boolean
  /** A burn of this flow's own runs, rather than a start's status. */
  live: boolean
  /** The user closed the flow. */
  closed: boolean
  failure?: ErrorCode
}

/** A bridge answer, kept for its ask; `fee` is its whole fee when it priced From itself. */
export interface PricedBridge {
  key: string
  floorRoute: string
  floor: bigint
  answer: BridgeOutAnswer
  fee?: { route: string; fee: bigint }
}

export type WithdrawEvent =
  | { type: "go"; step: WithdrawStep; gasAtomic?: bigint }
  /** Back one step, or to `to` (a retry from the status). */
  | { type: "back"; to?: WithdrawStep }
  | { type: "choose"; chosen: Chosen; then?: WithdrawStep }
  | { type: "typed"; text: string; side: "from" | "to" }
  | { type: "max" }
  | { type: "route"; chainId: number; coin: WithdrawalReceiveAsset }
  | { type: "gas"; gasAtomic: bigint }
  | { type: "speed"; speed: WithdrawalSpeed }
  /** A quote answered: a bridge's, a typed To's solve, and the fee the review checks. */
  | {
      type: "priced"
      bridge?: PricedBridge
      solve?: WithdrawSolve
      fee?: bigint
      lastFee?: { route: string; fee: bigint }
    }
  | { type: "enterReview"; feeAtomic?: bigint }
  | { type: "submitted"; plan: WithdrawPlan; chain: string }
  | { type: "staged"; stage?: WithdrawStage; localId?: string }
  | { type: "signing"; signing: boolean }
  | { type: "cancelled" }
  | { type: "failed"; code: ErrorCode }
  | { type: "closed" }

const UNREVIEWED = { feeAtomic: undefined, changed: false }

const offStatus = (s: WithdrawState): WithdrawState => ({
  ...s,
  history: s.history.filter((step) => step !== "status"),
  sent: undefined,
})

export function withdrawTransition(s: WithdrawState, e: WithdrawEvent): WithdrawState {
  switch (e.type) {
    case "go":
      return {
        ...s,
        history: [...s.history, e.step],
        ...(e.gasAtomic !== undefined ? { gasAtomic: e.gasAtomic } : {}),
      }
    case "back": {
      if (e.to) {
        const at = s.history.indexOf(e.to)
        return {
          ...s,
          history: at < 0 ? s.history : s.history.slice(0, at + 1),
          sent: undefined,
          review: UNREVIEWED,
          failure: undefined,
        }
      }
      const left = s.history.at(-1)
      return {
        ...s,
        history: s.history.length > 1 ? s.history.slice(0, -1) : s.history,
        ...(left === "review" ? { review: UNREVIEWED, failure: undefined } : {}),
      }
    }
    case "choose":
      return {
        ...s,
        chosen: e.chosen,
        history: e.then ? [...s.history, e.then] : s.history,
      }
    case "typed":
      return { ...s, amount: { text: e.text, side: e.side, maxed: false }, solve: undefined }
    case "max":
      return { ...s, amount: { ...s.amount, side: "from", maxed: true }, solve: undefined }
    case "route":
      // A typed To stays; From solves again on the new route.
      return {
        ...s,
        route: { chainId: e.chainId, coin: e.coin },
        ...(s.amount.side === "to" ? { solve: undefined } : {}),
      }
    case "gas":
      return { ...s, gasAtomic: e.gasAtomic }
    case "speed":
      return { ...s, speed: e.speed }
    case "priced": {
      let next = s
      if (e.bridge) {
        const { key, floorRoute, floor, answer, fee } = e.bridge
        next = {
          ...next,
          bridge: { key, answer },
          floor: { route: floorRoute, floor },
          ...(fee ? { lastFee: fee } : {}),
        }
      }
      if (e.lastFee) next = { ...next, lastFee: e.lastFee }
      if (e.solve) next = { ...next, solve: e.solve }
      const { review } = next
      // A fee first priced on the review was never shown, so it is no change.
      if (e.fee !== undefined && next.history.at(-1) === "review" && e.fee !== review.feeAtomic)
        next = {
          ...next,
          review: { feeAtomic: e.fee, changed: review.changed || review.feeAtomic !== undefined },
        }
      return next
    }
    case "enterReview":
      return {
        ...s,
        history: [...s.history, "review"],
        review: { feeAtomic: e.feeAtomic, changed: false },
        failure: undefined,
      }
    case "submitted":
      return {
        ...s,
        history: [...s.history, "status"],
        sent: { plan: e.plan, chain: e.chain },
        stage: "building",
        signing: true,
        live: true,
        failure: undefined,
      }
    case "staged":
      return {
        ...s,
        stage: e.stage,
        sent: s.sent && e.localId ? { ...s.sent, localId: e.localId } : s.sent,
      }
    case "signing":
      return { ...s, signing: e.signing }
    case "cancelled":
      return offStatus(s)
    case "failed":
      return { ...offStatus(s), failure: e.code }
    case "closed":
      return { ...s, closed: true }
  }
}
