import { createActivity, type Activity } from "../../src/engine/activity"
import { encodeRecord } from "../../src/engine/persistentStore"
import { createMemoryKv, type KvStore } from "../../src/engine/kv"
import type { Transaction } from "../../src/types/transactions"

/**
 * A real activity store over memory, holding `rows` as saved records. A row without an id is keyed
 * by its hash, as a scanned row is; one without either by its position.
 */
export function seededActivity(
  rows: readonly Partial<Transaction>[] = [],
  opts: {
    kv?: KvStore
    networkId?: string
  } = {},
): Activity {
  const kv = opts.kv ?? createMemoryKv()
  kv.setItem("acct/meta/activity", "1")
  rows.forEach((row, i) => {
    const id = row.id ?? (row.txHash ? row.txHash.toLowerCase() : `row-${i}`)
    kv.setItem(`acct/activity/${id}`, encodeRecord({ amountAtomic: 0n, ...row, id }))
  })
  return createActivity({ kv, networkId: () => opts.networkId })
}
