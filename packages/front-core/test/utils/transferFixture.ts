import { createTransfers, type Transfers } from "../../src/engine/transfers"
import { openDatabase, type Database, type Write } from "../../src/engine/database"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import { operationIndex } from "../../src/engine/operations"
import { createPaylinks, legacyLinkRows, type Paylinks } from "../../src/engine/paylinks"
import type { PaylinkEvent, PaylinkRecord } from "../../src/engine/paylinkTransition"
import { encodeRecord, loadRecords } from "../../src/engine/persistentStore"
import type { Transaction } from "../../src/types/transactions"

/** An activity store over `db`. */
export const openActivity = (db: Database) => createTransfers({ db, now: () => Date.now() })

const LINK_EVENTS = new Set<string>([
  "funded",
  "claimed",
  "unclaimed",
  "refundSubmitted",
  "refunded",
  "refundDropped",
  "migrated",
])

/**
 * A real activity store over memory, holding `rows` as saved records. A row without an id is keyed
 * by its hash, as a scanned row is; one without either by its position. A created link's row moves
 * to `paylinks` on open; `get` shows a row with its link, as the views read it, and `apply` takes
 * a link's events to its link. `db` is the database it writes, for writes that join it.
 */
export function seededActivity(
  rows: readonly Partial<Transaction>[] = [],
  opts: { backend?: MemoryBackend } = {},
): Transfers & { db: Database; backend: MemoryBackend; paylinks: Paylinks } {
  const backend = opts.backend ?? memoryBackend()
  // Saved as the previous version holds them: the open builds their indexes.
  backend.entries.set("acct/meta/activity", "1")
  rows.forEach((row, i) => {
    const id = row.id ?? (row.txHash ? row.txHash.toLowerCase() : `row-${i}`)
    backend.entries.set(`acct/activity/${id}`, encodeRecord({ amountAtomic: 0n, ...row, id }))
  })
  const db = openDatabase(backend)
  const transfers = openActivity(db)
  const paylinks = createPaylinks({ db, transfers })
  const linkOf = async (row: Transaction, w?: Write) => {
    const [byOperation] = row.operationId
      ? await loadRecords(paylinks.where("operation", row.operationId.toLowerCase()))
      : []
    return byOperation ?? (row.txHash ? await paylinks.byHash(row.txHash, w) : undefined)
  }
  /** The row as an older build kept it, its link's fields on it. */
  const linkRow = (link: PaylinkRecord, row: Transaction) =>
    legacyLinkRows([row], [link], operationIndex([]))[0]
  const get = async (id: string, w?: Write) => {
    const row = await transfers.get(id, w)
    const link = row && (await linkOf(row, w))
    return link ? linkRow(link, row) : row
  }
  return {
    ...transfers,
    ready: Promise.all([transfers.ready, paylinks.ready]).then(() => undefined),
    get,
    async apply(id, event, w) {
      if (!LINK_EVENTS.has(event.type)) return transfers.apply(id, event, w)
      const row = await transfers.get(id, w)
      const link = row && (await linkOf(row, w))
      const next = link && (await paylinks.apply(link.id, event as unknown as PaylinkEvent, w))
      return next && linkRow(next, row)
    },
    db,
    backend,
    paylinks,
  }
}
