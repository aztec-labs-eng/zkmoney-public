import type { TokenInTxService } from "../types/tokens"
import type { Failure } from "./errors"

/**
 * `local`: proving or submitting in this tab, which closing loses. `sent`: the hash is on the flow's
 * own record, so the chain decides from here and the tab may close. Only a page that is still
 * running an operation can advance it past `local`, so a `local` record from a page that no longer
 * runs the wallet was interrupted.
 */
export type OperationState = "local" | "sent" | "settled" | "failed"

/**
 * Why a record failed with no error of the flow's: `interrupted` ended before it was sent,
 * `dropped` was sent and the network turned it down.
 */
export type OperationFailureCause = "interrupted" | "dropped"

/** What a contact send's row shows; the send has no record but its operation. */
export interface SendPayload {
  networkId: string
  token: TokenInTxService
  /** Base units, as a decimal string. */
  amountAtomic: string
  to: string
  toTag?: string
  memo?: string
  /** The payment request it pays. */
  requestId?: string
}

/** What a link's claim or refund shows; the chain's payout files no row of its own. */
export interface PayoutPayload {
  networkId: string
  token: TokenInTxService
  /** Base units, as a decimal string; "0" while the note is unread. */
  amountAtomic: string
  flavor: "direct" | "email"
  /** The link's key in `paylinks`, whoever made it. */
  linkId: string
  /** The creator's memo, read off the payout. */
  memo?: string
}

/** An operation that is a transfer's only record carries what its row shows. */
export type OperationKind =
  | { kind?: undefined; payload?: undefined }
  | { kind: "send"; payload: SendPayload }
  | { kind: "paylink-claim"; payload: PayoutPayload }
  /** A refund's row is the link's: the feed shows its state on the link. */
  | { kind: "paylink-refund"; payload: PayoutPayload }

/**
 * The fields only an operation holds. A domain record that names its operation by `operationId`
 * declares none of them: see {@link DomainRecord}.
 */
export type Lifecycle =
  | "state"
  | "status"
  | "detailedStatus"
  | "progress"
  | "failure"
  | "error"
  | "cause"
  | "startedAt"
  | "endedAt"
  | "startTime"
  | "endTime"

/** A record type that keeps its domain facts and leaves the lifecycle to its operation. */
export type DomainRecord<T extends { [K in keyof T]: K extends Lifecycle ? never : unknown }> = T

/**
 * The one record of a user-started transaction, from its first proof to its fate on chain. Every
 * surface that says whether the tab may close (the flow's modal, the bell, the leave guard) reads
 * it, the notifications panel lists it running and ended, and one boot pass settles it after a
 * reload.
 */
export type OperationRecord = OperationBase & OperationKind

export interface OperationBase {
  operationId: string
  /** The caller's flow key; the store attaches no meaning to it. */
  flow: string
  /** One line naming the transaction, e.g. "$25 to @alice". */
  summary: string
  /** The operation this one runs inside, e.g. a claim's deposit address. */
  parent?: string
  /**
   * Its owner retries it after a reload: a `local` one interrupted, or a `sent` one the chain
   * dropped, goes back to its owner instead of failing.
   */
  resumable?: boolean
  /**
   * Bookkeeping the user never asked for, such as a deposit address's broadcast: no notification
   * shows it, and leaving the page does not lose it.
   */
  background?: boolean
  state: OperationState
  startedAt: number
  /**
   * When the wallet began proving it. A record that never got here lost nothing when it stopped,
   * so it is dropped rather than failed.
   */
  provingStartedAt?: number
  /**
   * When its screen handed the user off to the notifications panel. From then on the record, not the
   * screen, reports a failure, so one that ends before proving is failed rather than dropped.
   */
  handedOffAt?: number
  txHash?: string
  /** The message a flow failed with. */
  error?: string
  /** The `WalletError` code a flow failed with: a reader tells a retryable failure from a final one. */
  failure?: Pick<Failure, "code">
  cause?: OperationFailureCause
  endedAt?: number
  /** The notifications panel showed its ending. */
  readAt?: number
  /** Cleared from the notifications panel. */
  dismissedAt?: number
  /** Its block is final: no reorg reopens it. */
  finalized?: boolean
}

export type OperationEvent =
  /** The first proof under the record's id began. */
  | { type: "proving"; at: number }
  | { type: "handedOff"; at: number }
  /** Its owner runs a resumable record again, as a fresh attempt; its start and summary stay. */
  | { type: "resumed" }
  /** The flow read what the summary names after it began. */
  | { type: "described"; summary: string }
  /** The flow read what its transfer's row shows, before the proof. */
  | { type: "transfer"; transfer: Exclude<OperationKind, { kind?: undefined }> }
  /** The flow's record holds the hash. */
  | { type: "sent"; txHash: string }
  | { type: "settled"; at: number; txHash?: string }
  /** The chain's receipt reopened an ended transaction: the chain decides it again. */
  | { type: "demoted" }
  | { type: "finalized" }
  /** The chain's copy of a transfer carries a memo its operation lacks. */
  | { type: "noted"; memo: string }
  /** `quiet`: no notification reports it, e.g. a transfer that failed before its proof. */
  | {
      type: "failed"
      at: number
      error?: string
      failure?: Pick<Failure, "code">
      cause?: OperationFailureCause
      quiet?: boolean
    }
  | { type: "read"; at: number }
  | { type: "dismissed"; at: number }

const ended = (r: OperationRecord) => r.state === "settled" || r.state === "failed"

/**
 * The one place an operation changes; `undefined` leaves it as it is.
 * - Only a `local` record proves, is handed off, takes its transfer or is sent.
 * - An ended record changes again only to be read, cleared or finalized, or when the chain's
 *   receipt reopens it; its next ending is then reported afresh.
 * - A resumed record drops what its last attempt stamped.
 */
export function operationTransition(
  r: OperationRecord,
  e: OperationEvent,
): OperationRecord | undefined {
  switch (e.type) {
    case "proving":
      return r.state === "local" && r.provingStartedAt === undefined
        ? { ...r, provingStartedAt: e.at }
        : undefined
    case "handedOff":
      return r.state === "local" && r.handedOffAt === undefined
        ? { ...r, handedOffAt: e.at }
        : undefined
    case "resumed": {
      if (!r.resumable || r.endedAt !== undefined) return undefined
      const next: OperationRecord = { ...r, state: "local" }
      delete next.provingStartedAt
      delete next.handedOffAt
      delete next.txHash
      return next
    }
    case "described":
      return r.summary !== e.summary ? { ...r, summary: e.summary } : undefined
    case "transfer":
      return r.state === "local" ? { ...r, ...e.transfer } : undefined
    case "sent":
      return r.state === "local" ? { ...r, state: "sent", txHash: e.txHash } : undefined
    case "settled":
      return ended(r)
        ? undefined
        : { ...r, state: "settled", txHash: e.txHash ?? r.txHash, endedAt: e.at }
    case "demoted": {
      if (!ended(r) || !r.txHash || r.finalized) return undefined
      const next: OperationRecord = { ...r, state: "sent" }
      delete next.endedAt
      delete next.error
      delete next.failure
      delete next.cause
      delete next.readAt
      delete next.dismissedAt
      return next
    }
    case "finalized":
      return r.state === "settled" && !r.finalized ? { ...r, finalized: true } : undefined
    case "noted":
      return r.kind && !r.payload.memo
        ? ({ ...r, payload: { ...r.payload, memo: e.memo } } as OperationRecord)
        : undefined
    case "failed": {
      if (ended(r)) return undefined
      const { error, failure, cause, at: endedAt, quiet } = e
      const read = quiet ? endedAt : undefined
      return {
        ...r,
        error,
        failure,
        cause,
        state: "failed",
        endedAt,
        readAt: read,
        dismissedAt: read,
      }
    }
    case "read":
      return r.endedAt !== undefined && r.readAt === undefined ? { ...r, readAt: e.at } : undefined
    case "dismissed":
      return r.endedAt !== undefined && r.dismissedAt === undefined
        ? { ...r, readAt: r.readAt ?? e.at, dismissedAt: e.at }
        : undefined
  }
}
