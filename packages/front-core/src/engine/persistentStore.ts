import type { KvOp, KvStore } from "./kv"
import { memoryStore, type ReadonlyStore } from "./store"

/**
 * Typed records, one key per record (`<scope>/<name>/<id>`), loaded into memory at open. The
 * version lives at `<scope>/meta/<name>`. A version change runs `migrate` and saves its result in
 * one transaction.
 */
export interface PersistentStoreSpec<T> {
  scope: string
  name: string
  version: number
  /** `from` is the saved version, undefined before the store first opened. */
  migrate?: (
    from: number | undefined,
    saved: ReadonlyMap<string, unknown>,
    kv: KvStore,
  ) => Migrated<T>
}

export interface Migrated<T> {
  records: Iterable<readonly [string, T]>
  /** Other writes that land in the same transaction. */
  ops?: readonly KvOp[]
}

/** The saved records by id: a write shows once it lands, and a failed one never does. */
export interface PersistentStore<T> extends ReadonlyStore<ReadonlyMap<string, T>> {
  /** Resolves once the open's migration is saved; a failed one retries until it is. */
  readonly ready: Promise<void>
  /** The latest write, saved or not: what a writer reads. A failed write drops out of it. */
  latest(id: string): T | undefined
  /** Saves in the background, or with the open `kv.batch`. */
  put(id: string, record: T): void
  remove(id: string): void
}

const BIGINT = "$bigint"
const FIRST_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000

/** JSON with every bigint kept exactly, as `{ "$bigint": "<decimal>" }`. */
export function encodeRecord(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "bigint" ? { [BIGINT]: v.toString() } : v,
  )
}

export function decodeRecord(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v === null || typeof v !== "object") return v
    const tagged = (v as Record<string, unknown>)[BIGINT]
    return typeof tagged === "string" && Object.keys(v).length === 1 ? BigInt(tagged) : v
  })
}

/** Where a store keeps its records: `<scope>/<name>/<id>`. */
export const recordPrefix = (spec: Pick<PersistentStoreSpec<unknown>, "scope" | "name">) =>
  `${spec.scope}/${spec.name}/`

export function persistentStore<T>(kv: KvStore, spec: PersistentStoreSpec<T>): PersistentStore<T> {
  const prefix = recordPrefix(spec)
  const metaKey = `${spec.scope}/meta/${spec.name}`
  /** Each id's last decode, so a read of unchanged text is the same object. */
  const decoded = new Map<string, readonly [raw: string, record: T]>()
  const read = (id: string, raw: string): T => {
    const hit = decoded.get(id)
    if (hit?.[0] === raw) return hit[1]
    const record = decodeRecord(raw) as T
    decoded.set(id, [raw, record])
    return record
  }
  const latest = (id: string) => {
    const raw = kv.getItem(prefix + id)
    return raw === null ? undefined : read(id, raw)
  }

  // At open nothing is in flight under the prefix, so what the kv holds is what was saved.
  const saved = new Map<string, unknown>()
  const rawOf = new Map<string, string>()
  for (const key of kv.keys()) {
    if (!key.startsWith(prefix)) continue
    const raw = kv.getItem(key)
    if (raw === null) continue
    const id = key.slice(prefix.length)
    saved.set(id, read(id, raw))
    rawOf.set(id, raw)
  }
  const stored = kv.getItem(metaKey)
  const from = stored === null ? undefined : Number(stored)
  const current = from === spec.version

  const store = memoryStore<ReadonlyMap<string, T>>(current ? (saved as Map<string, T>) : new Map())
  if (!current) rawOf.clear()
  // Released with the kv's own subscriptions (`prefixedKv`'s signal).
  kv.onCommit((ops) => {
    let next: Map<string, T> | undefined
    for (const [key, raw] of ops) {
      if (!key.startsWith(prefix)) continue
      const id = key.slice(prefix.length)
      if ((rawOf.get(id) ?? null) === raw) continue
      next ??= new Map(store.get())
      if (raw === null) {
        next.delete(id)
        rawOf.delete(id)
      } else {
        next.set(id, read(id, raw))
        rawOf.set(id, raw)
      }
    }
    if (next) store.set(next)
  })

  const migrate = (held: ReadonlyMap<string, unknown>) => {
    const migrated = upgrade(spec, from, held, kv)
    const records = new Map(migrated.records)
    const ops: KvOp[] = [...(migrated.ops ?? [])]
    for (const id of held.keys()) if (!records.has(id)) ops.push([prefix + id, null])
    for (const [id, record] of records) {
      const raw = encodeRecord(record)
      decoded.set(id, [raw, record])
      ops.push([prefix + id, raw])
    }
    ops.push([metaKey, String(spec.version)])
    return kv.commitTransaction(ops)
  }
  /** What the kv holds under the prefix now, writes made since the open included. */
  const held = () =>
    new Map(
      kv
        .keys()
        .filter((key) => key.startsWith(prefix))
        .flatMap((key) => {
          const id = key.slice(prefix.length)
          const record = latest(id)
          return record === undefined ? [] : [[id, record] as const]
        }),
    )
  // A failed migration runs again over what the kv then holds, until it lands.
  const retry = (delayMs: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, delayMs)).then(() =>
      migrate(held()).catch(() => retry(Math.min(delayMs * 2, MAX_RETRY_MS))),
    )
  const ready = current ? Promise.resolve() : migrate(saved).catch(() => retry(FIRST_RETRY_MS))

  return {
    get: store.get,
    subscribe: store.subscribe,
    ready,
    latest,
    put(id, record) {
      const raw = encodeRecord(record)
      if (kv.getItem(prefix + id) === raw) return
      decoded.set(id, [raw, record])
      kv.setItem(prefix + id, raw)
    },
    remove(id) {
      if (kv.getItem(prefix + id) !== null) kv.removeItem(prefix + id)
    },
  }
}

function upgrade<T>(
  spec: PersistentStoreSpec<T>,
  from: number | undefined,
  saved: ReadonlyMap<string, unknown>,
  kv: KvStore,
): Migrated<T> {
  if (spec.migrate) return spec.migrate(from, saved, kv)
  if (from === undefined) return { records: [] }
  throw new Error(`${spec.name}: no migration from version ${from} to ${spec.version}`)
}
