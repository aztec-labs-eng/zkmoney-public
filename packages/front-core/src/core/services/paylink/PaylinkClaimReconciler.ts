import type { PaylinkService } from "@obsidion/sdk"
import type { PaylinkTransaction } from "../../../types"
import { stampedOn } from "../../../types/networkStamp"
import type { Transfers } from "../../../engine/transfers"
import {
  FUNDING_STATUS,
  operationIndex,
  refundRuns,
  withOperation,
} from "../../../engine/operations"
import type { Operations } from "../../../engine/operations"
import type { Paylinks } from "../../../engine/paylinks"
import type { PaylinkRecord } from "../../../engine/paylinkTransition"
import { loadRecords } from "../../../engine/persistentStore"
import { refundParamsFromRow } from "./refundParamsFromRow"
import { logger } from "../../../utils/logger"

/**
 * Creator-side detection of off-device paylink claims.
 *
 * The on-chain primitive (`isPaylinkClaimed`) only proves the note's nullifier was spent, and a
 * claim and a refund spend the same note. So a spent link reads claimed only with no refund signal:
 * none in flight here, none submitted (`refundTxHash`), and a link a refund scrubbed has no
 * `paylink` to check. An unspent read of a claimed link is unambiguous: its claim reorged out.
 */

/** What a spend check reads of a link. */
export type SpendCheckInput = Pick<PaylinkTransaction, "txHash" | "paylink" | "fallbackSecret">

/** Maps each link's funding `txHash` to whether its note is spent on chain. */
export type CheckSpent = (links: readonly SpendCheckInput[]) => Promise<Map<string, boolean>>

export interface LinkSweepDeps {
  /** One batched read per pass. */
  checkSpent: CheckSpent
  links: Pick<Paylinks, "view" | "apply">
  /** The refunds' operations: one running keeps its link unclaimed, its outcome settles it. */
  operations: Pick<Operations, "view">
  /** A refund's row where an older build kept one. */
  transfers: Pick<Transfers, "byHash">
}

/** A link a claim may have spent: escrowed, no refund signal, its refund material and funding hash. */
const isCandidate = (link: PaylinkRecord, ops: LinkSweepDeps["operations"]) =>
  !link.isClaimed &&
  !link.isRefunded &&
  !link.isMigrated &&
  !link.refundTxHash &&
  !!link.paylink &&
  !!link.fallbackSecret &&
  !!link.txHash &&
  !refundRuns(ops, link.id)

/** A claimed link whose claim a reorg may undo, read on `networkId`'s chain. */
const isClaimedCandidate = (link: PaylinkRecord, networkId: string) =>
  link.isClaimed === true &&
  !link.isRefunded &&
  !link.isMigrated &&
  !!link.paylink &&
  !!link.fallbackSecret &&
  !!link.txHash &&
  stampedOn(link, networkId)

/**
 * Marks migrated a created link whose escrow an upgrade refunded on L1; a claimed or refunded link
 * stays as it is. True exactly once.
 */
export async function markPaylinkMigrated(
  txHash: string,
  links: Pick<Paylinks, "byHash" | "apply">,
): Promise<boolean> {
  const link = await links.byHash(txHash)
  return !!link && !!(await links.apply(link.id, { type: "migrated" }))
}

/**
 * Undoes a claim a reorg removed, bumping the link's epoch so a sweep that read it before cannot
 * claim it again. `expectedEpoch` fences a demote read before another. True on the genuine change.
 */
export async function demotePaylinkClaim(
  txHash: string,
  links: Pick<Paylinks, "byHash" | "apply">,
  expectedEpoch?: number,
): Promise<boolean> {
  const link = await links.byHash(txHash)
  if (!link) return false
  return !!(await links.apply(link.id, {
    type: "unclaimed",
    epoch: expectedEpoch ?? link.reorgEpoch,
  }))
}

/**
 * One pass over the links: carries each submitted refund's outcome back to its link, claims each
 * spent candidate, and undoes each claim on `networkId` whose note reads unspent. Once `signal`
 * aborts it writes nothing more, so a pass the page left cannot land after a newer one.
 */
export async function sweepLinks(
  deps: LinkSweepDeps,
  networkId: string,
  signal?: AbortSignal,
): Promise<void> {
  const [links, ops] = await Promise.all([
    loadRecords(deps.links.view),
    loadRecords(deps.operations.view).then(operationIndex),
  ])
  for (const link of links) {
    const { refundTxHash } = link
    if (!refundTxHash || link.isRefunded || link.isMigrated) continue
    const { op, funding } = withOperation({ txHash: refundTxHash }, ops)
    const status = op
      ? FUNDING_STATUS[funding]
      : (await deps.transfers.byHash(refundTxHash))?.status
    if (!status || status === "pending") continue
    if (signal?.aborted) return
    await deps.links.apply(
      link.id,
      status === "success"
        ? { type: "refunded", refundTxHash }
        : { type: "refundDropped", refundTxHash },
    )
  }
  const candidates = links.filter((link) => isCandidate(link, deps.operations))
  const claimed = links.filter((link) => isClaimedCandidate(link, networkId))
  if (candidates.length === 0 && claimed.length === 0) return
  // Read before the spend check: a demote landing meanwhile makes this pass's reads stale.
  const epochs = new Map([...candidates, ...claimed].map((l) => [l.id, l.reorgEpoch ?? 0]))
  const spent = await deps.checkSpent([...candidates, ...claimed] as SpendCheckInput[])
  for (const link of candidates) {
    if (signal?.aborted) return
    if (spent.get(link.txHash!) !== true) continue
    // The transition rereads the link, so a refund that started meanwhile keeps it unclaimed.
    await deps.links.apply(link.id, {
      type: "claimed",
      at: Date.now(),
      epoch: epochs.get(link.id),
      refundInFlight: refundRuns(deps.operations, link.id),
      by: "chain",
    })
  }
  // Only an explicit unspent read demotes: a missing entry is a link the check could not read.
  for (const link of claimed) {
    if (signal?.aborted) return
    if (spent.get(link.txHash!) !== false) continue
    await deps.links.apply(link.id, { type: "unclaimed", epoch: epochs.get(link.id) })
  }
}

/**
 * `CheckSpent` over `PaylinkService.isPaylinkClaimed`: one nullifier read per link, in turn. A link
 * whose read fails is left out of the map, so it reads unknown, never unspent.
 */
export function checkSpentViaPaylinkService(
  paylinkService: Pick<PaylinkService, "isPaylinkClaimed">,
): CheckSpent {
  return async (links) => {
    const result = new Map<string, boolean>()
    for (const link of links) {
      try {
        const params = await refundParamsFromRow(link)
        if (!params) continue
        result.set(link.txHash, await paylinkService.isPaylinkClaimed(params))
      } catch (err) {
        logger.warn("[PaylinkClaimReconciler] checkSpent row failed:", link.txHash, err)
      }
    }
    return result
  }
}
