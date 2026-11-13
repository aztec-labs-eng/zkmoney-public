import { convertSavingsMoves, type SavedMovesChain } from "../storageMigrations/savingsMoves"
export type { SkyHoldingRef } from "../storageMigrations/savingsMoves"
import type { Address, Hash } from "viem"
import type { Database, Write } from "./database"
import { WalletError } from "./errors"
import { isMoveSettled, moveTransition, type MoveEvent, type MoveRecord } from "./moveTransition"
import { encodeRecord, loadRecords, persistentStore, type RecordSet } from "./persistentStore"
import type { ReadonlyStore } from "./store"

/**
 * The account's moves, one record each, changed only through `moveTransition`. A write without `w`
 * commits on its own; with one, it joins that transaction, so a move commits with its cursor.
 */
export interface MoveStore {
  readonly ready: Promise<void>
  /** Every saved move. */
  readonly view: ReadonlyStore<RecordSet<MoveRecord>>
  get(id: string, w?: Write): Promise<MoveRecord | undefined>
  /** The record when `event` changed it. */
  apply(id: string, event: MoveEvent, w?: Write): Promise<MoveRecord | undefined>
  /** Every move not settled, read once; rejects when the read fails. */
  open(): Promise<readonly MoveRecord[]>
}

const PREFIX = "acct/moves"
const VERSION_KEY = "acct/meta/moves"

/** What the first open needs to convert an older build's Savings moves. */
export interface SavedMovesSource extends SavedMovesChain {
  /** The withdrawals store's open: the conversion reads each move's burn after its migration. */
  withdrawals: Promise<unknown>
}

export function createMoveStore(db: Database, saved?: SavedMovesSource): MoveStore {
  // Read before the open's write, so the holding's read never holds the database's writes.
  const converted =
    saved &&
    (async () => {
      await saved.withdrawals
      const [version] = await db.getMany([VERSION_KEY])
      return version === undefined ? convertSavingsMoves(db, saved) : undefined
    })()
  const store = persistentStore<MoveRecord>(db, {
    prefix: PREFIX,
    version: 1,
    id: (record) => record.id,
    load: "all",
    ...(converted ? { after: converted } : {}),
    async migrate(from, w) {
      if (from !== undefined) throw new WalletError("invariant", `moves: unknown version ${from}`)
      for (const record of (await converted)?.records ?? [])
        w.put(`${PREFIX}/${record.id}`, encodeRecord(record))
    },
  })
  return {
    ready: store.ready,
    view: store.view,
    get: (id, w) => store.get(id, w),
    apply: (id, event, w) => store.apply(id, (record) => moveTransition(record, event), w),
    open: async () => (await loadRecords(store.view)).filter((record) => !isMoveSettled(record)),
  }
}

/**
 * Marks recovered each retired move whose deposit an old version's refund to `to` in `txHash`
 * returned. A leaf index names a deposit only within its rollup's Inbox, so the amount must match.
 */
export async function noteRefundedMoves(
  moves: Pick<MoveStore, "view" | "apply">,
  deposits: readonly { leafIndex: string; amount: string }[],
  refund: { to: Address; txHash: Hash; at: number },
): Promise<void> {
  if (!deposits.length) return
  const refunded = (move: MoveRecord) =>
    move.phase === "migrated" &&
    !!move.deposit &&
    deposits.some(
      (d) =>
        d.leafIndex === String(move.deposit?.inboxIndex) &&
        d.amount === String(move.deposit?.amount),
    )
  for (const move of await loadRecords(moves.view))
    if (refunded(move)) await moves.apply(move.id, { type: "recovered", ...refund })
}
