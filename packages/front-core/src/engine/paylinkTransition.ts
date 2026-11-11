import type { PaylinkTransaction } from "../types/transactions"
import type { DomainRecord } from "./operationTransition"

type RefundKind = NonNullable<PaylinkTransaction["refundKind"]>

/**
 * A link this account created, keyed by `linkIdentity(type, secret)` so no key holds the secret.
 * It holds the escrow's facts and its claim and refund lifecycle; whether its funding went out is
 * its operation's, read through `withOperation`.
 */
export type PaylinkRecord = DomainRecord<{
  id: string
  /** When the link was made. */
  timestamp: number
  operationId?: string
  /** The escrow's funding hash, saved before the node takes it: the note, rescan and refund key. */
  txHash?: string
  networkId?: string
  kind?: PaylinkTransaction["kind"]
  amountAtomic: bigint
  token?: PaylinkTransaction["token"]
  tokenAddress?: string
  flavor: PaylinkTransaction["flavor"]
  payToEmailSecret: string
  fallbackSecret?: string
  obsidionAccountAddress?: string
  partialAddress?: string
  from?: string
  to?: string
  memo?: string
  fromClaimable?: number
  untilClaimable?: number
  refundableUntil?: number
  /** The shareable URL; it carries the secret, so a claim by this account or a refund drops it. */
  paylink?: string
  isClaimed?: boolean
  claimedAt?: number
  claimedBy?: "self" | "chain"
  isRefunded?: boolean
  refundTxHash?: string
  refundKind?: RefundKind
  isMigrated?: boolean
  /** Bumped by each reorg that unspends the link; stale claim writes carry an older one. */
  reorgEpoch?: number
}>

/**
 * What changes a link. The create flow writes `sent` and `funded`; the sweep writes `claimed` and
 * `unclaimed`; a refund writes `refundSubmitted`, then `refunded` or `refundDropped`; an upgrade
 * off a retired deployment writes `migrated`. `epoch` is the record's `reorgEpoch` when the writer
 * read it; absent, it is 0.
 */
export type PaylinkEvent =
  | { type: "sent"; txHash: string }
  /** The funding settled: the URL now names the transaction. */
  | { type: "funded"; paylink: string }
  /**
   * A claim spent the escrow, seen at `at`. `by`: this account claimed it (`self`), so the URL
   * goes, or the chain showed another's claim.
   */
  | { type: "claimed"; at: number; epoch?: number; refundInFlight: boolean; by: "self" | "chain" }
  /** A reorg unspent a claimed escrow. */
  | { type: "unclaimed"; epoch?: number }
  | { type: "refundSubmitted"; refundTxHash: string; refundKind: RefundKind }
  | { type: "refunded"; refundTxHash?: string; refundKind?: RefundKind }
  /** The submitted refund `refundTxHash` failed, so the link is refundable again. */
  | { type: "refundDropped"; refundTxHash: string }
  /** An upgrade returned the escrow on L1, which leaves its L2 note unspent. */
  | { type: "migrated" }

// eslint-disable-next-line no-restricted-syntax -- ZKM-1778
const FENCED = new Set<PaylinkEvent["type"]>(["claimed", "unclaimed"])

/**
 * The one place a link changes; `undefined` leaves it as it is.
 * - A migrated link never changes.
 * - A `claimed` or `unclaimed` from another epoch than the link's is ignored.
 * - A link takes one funding hash, and a URL only once it has one.
 * - Claimed and refunded exclude each other, and a link with a refund in flight or submitted is not
 *   claimed. A claim this account made overrides one the chain showed first.
 */
export function paylinkTransition(
  link: PaylinkRecord,
  event: PaylinkEvent,
): PaylinkRecord | undefined {
  if (link.isMigrated) return undefined
  if (
    FENCED.has(event.type) &&
    ((event as { epoch?: number }).epoch ?? 0) !== (link.reorgEpoch ?? 0)
  )
    return undefined
  switch (event.type) {
    case "sent":
      if (!event.txHash || (link.txHash && link.txHash !== event.txHash)) return undefined
      return link.txHash ? undefined : { ...link, txHash: event.txHash }
    case "funded":
      if (!link.txHash || link.isClaimed || link.isRefunded || link.paylink === event.paylink)
        return undefined
      return { ...link, paylink: event.paylink }
    case "claimed": {
      if (link.isRefunded || link.refundTxHash || event.refundInFlight) return undefined
      const self = event.by === "self"
      if (link.isClaimed) {
        return self && link.claimedBy !== "self"
          ? { ...link, claimedBy: "self", paylink: undefined }
          : undefined
      }
      return {
        ...link,
        isClaimed: true,
        claimedAt: link.claimedAt ?? event.at,
        claimedBy: self ? "self" : link.claimedBy ?? event.by,
        ...(self ? { paylink: undefined } : {}),
      }
    }
    case "unclaimed":
      if (!link.isClaimed) return undefined
      return { ...link, isClaimed: false, reorgEpoch: (link.reorgEpoch ?? 0) + 1 }
    case "refundSubmitted":
      if (link.isRefunded) return undefined
      return { ...link, refundTxHash: event.refundTxHash, refundKind: event.refundKind }
    case "refunded":
      if (link.isRefunded) return undefined
      return {
        ...link,
        isRefunded: true,
        ...(link.isClaimed ? { isClaimed: false } : {}),
        paylink: undefined,
        refundTxHash: event.refundTxHash ?? link.refundTxHash,
        refundKind: event.refundKind ?? link.refundKind,
      }
    case "refundDropped":
      if (link.isRefunded || link.refundTxHash !== event.refundTxHash) return undefined
      return { ...link, refundTxHash: undefined, refundKind: undefined }
    case "migrated":
      if (link.isClaimed || link.isRefunded) return undefined
      return { ...link, isMigrated: true }
  }
}
