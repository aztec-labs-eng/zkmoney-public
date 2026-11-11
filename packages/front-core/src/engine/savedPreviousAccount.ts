import type { Database } from "./database"
import { WalletError } from "./errors"
import { decodeRecord, persistentStore } from "./persistentStore"
import { derived, type ReadonlyStore } from "./store"

const ID = "previous"

/** The move chunk in flight from the previous account, saved before its transfer leaves. */
export interface PreviousAccountMove {
  /** The session's account it moves to. */
  destination: string
  txHash: string
  /** Capped when saved; never recomputed. */
  expiresAtMs: number
  amount: bigint
}

interface Saved {
  id: typeof ID
  address: string
  move?: PreviousAccountMove
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const isMove = (v: unknown): v is PreviousAccountMove => {
  const move = v as Partial<PreviousAccountMove> | null
  return (
    typeof move?.destination === "string" &&
    typeof move.txHash === "string" &&
    Number.isFinite(move.expiresAtMs) &&
    typeof move.amount === "bigint"
  )
}

/** A saved record, or a throw that fails every read: a damaged chunk never reads as none in flight. */
function savedOf(raw: string): Saved {
  const value = decodeRecord(raw) as Partial<Saved> | null
  if (
    value?.id === ID &&
    typeof value.address === "string" &&
    (value.move === undefined || isMove(value.move))
  )
    return value as Saved
  throw new WalletError("unknown", "the saved previous account is damaged")
}

/**
 * A rotated wallet's previous account as the last search found it, saved so the feed and the bell
 * know it from the session's first frame rather than once the next search answers. It also keeps the
 * move's chunk in flight, so a reload resolves that chunk by its hash and never sends it twice.
 */
export interface SavedPreviousAccount {
  /** Undefined until the read lands, and for an account with none. */
  readonly address: ReadonlyStore<string | undefined>
  /** Undefined forgets it. A new address drops the chunk in flight from the old one. */
  save(address: string | undefined): Promise<void>
  /** The chunk in flight from `address`. */
  move(address: string): Promise<PreviousAccountMove | undefined>
  saveMove(address: string, move: PreviousAccountMove): Promise<void>
  /** Drops the chunk in flight from `address` while it is still `txHash`. */
  clearMove(address: string, txHash: string): Promise<void>
}

export function createSavedPreviousAccount(db: Database): SavedPreviousAccount {
  const store = persistentStore<Saved>(db, {
    prefix: "acct/previousAccount",
    version: 1,
    id: (saved) => saved.id,
    decode: savedOf,
    load: "all",
  })
  return {
    address: derived([store.view], (view) => view.records[0]?.address),
    async save(address) {
      if (address) {
        await store.apply(ID, (saved) =>
          saved && same(saved.address, address) ? undefined : { id: ID, address },
        )
      } else if (await store.get(ID)) {
        await store.remove(ID)
      }
    },
    async move(address) {
      const saved = await store.get(ID)
      return saved && same(saved.address, address) ? saved.move : undefined
    },
    async saveMove(address, move) {
      await store.apply(ID, (saved) => ({
        ...(saved && same(saved.address, address) ? saved : { id: ID, address }),
        move,
      }))
    },
    async clearMove(address, txHash) {
      await store.apply(ID, (saved) => {
        if (!saved || !same(saved.address, address) || saved.move?.txHash !== txHash) return
        return { id: saved.id, address: saved.address }
      })
    },
  }
}
