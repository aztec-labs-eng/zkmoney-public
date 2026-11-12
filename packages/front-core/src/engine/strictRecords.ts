import type { Database, Write } from "./database"
import {
  decodeRecord,
  encodeRecord,
  loadRecords,
  persistentStore,
  type RecordSet,
} from "./persistentStore"
import type { ReadonlyStore } from "./store"

/**
 * Records one per lowercased key, for state that holds funds in flight. A saved record that fails
 * its check fails the load: the view is `failed` and every read and write rejects, so nothing reads
 * it as no record.
 */
export interface StrictRecords<R> {
  readonly ready: Promise<void>
  readonly view: ReadonlyStore<RecordSet<R>>
  get(key: string): Promise<R | null>
  /**
   * Read-modify-write under `key` in one step, so a change decided over a stale copy is never
   * written. `change` returns null to leave the record as it is. Resolves to what the store holds
   * afterwards.
   */
  update(key: string, change: (current: R | null) => R | null): Promise<R | null>
  /** Drops the record only while it still passes `when`, read in the removing write. */
  removeIf(key: string, when: (current: R) => boolean): Promise<boolean>
}

export function strictRecords<R>(
  db: Database,
  spec: {
    prefix: string
    /** The field whose lowercased value keys a record. */
    field: keyof R & string
    /** A value as the record under `key`; throws for one that fails the check. */
    check(value: unknown, key: string): R
    /**
     * Replaces `check` where this store decodes a saved row, so a hook in it never hears a refused
     * write. A migration that carries rows passes it itself.
     */
    checkSaved?(value: unknown, key: string): R
    migrate(
      from: number | undefined,
      w: Write,
      store: { prefix: string; id(record: R): string },
    ): Promise<void>
  },
): StrictRecords<R> {
  const keyOf = (value: unknown) => {
    const key = (value as Record<string, unknown> | null)?.[spec.field]
    return typeof key === "string" ? key.toLowerCase() : ""
  }
  const ids = { prefix: spec.prefix, id: keyOf }
  const store = persistentStore<R>(db, {
    ...ids,
    version: 1,
    // A record checks against the key it is stored under, so one naming another key fails the load.
    decode: (raw, id) => (spec.checkSaved ?? spec.check)(decodeRecord(raw), id),
    migrate: (from, w) => spec.migrate(from, w, ids),
    load: "all",
  })
  /** Rejects while the saved records do not read. */
  const readable = () => loadRecords(store.view)
  return {
    ready: store.ready,
    view: store.view,
    async get(key) {
      await readable()
      return (await store.get(key.toLowerCase())) ?? null
    },
    async update(key, change) {
      await readable()
      let held: R | null = null
      await store.apply(key.toLowerCase(), (current) => {
        const next = change(current ?? null)
        // A record the decoder would refuse is never saved: the write rejects instead.
        if (next) spec.check(decodeRecord(encodeRecord(next)), key.toLowerCase())
        held = next ?? current ?? null
        return next ?? undefined
      })
      return held
    },
    async removeIf(key, when) {
      await readable()
      return db.write(async (w) => {
        const current = await store.get(key.toLowerCase(), w)
        if (current === undefined || !when(current)) return false
        await store.remove(key.toLowerCase(), w)
        return true
      })
    },
  }
}
