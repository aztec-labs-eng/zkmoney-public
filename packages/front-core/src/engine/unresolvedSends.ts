import type { Database } from "./database"
import { WalletError } from "./errors"
import { persistentStore, type RecordSet } from "./persistentStore"
import { isUnfundedSipaDeposit } from "./sipaDepositTransition"
import type { SipaDeposit } from "./sipaDeposits"
import type { ReadonlyStore } from "./store"
import { migrateUnresolvedSends } from "../storageMigrations/unresolvedSends"

/**
 * A send approved, or put to a wallet, with no known hash: a desktop deposit or a registration
 * payment. The wallet may still send it, so new funding is held until funds reach that address, a
 * hash is known, or the user starts again.
 */
export interface UnresolvedSend {
  id: typeof HOLD
  address: string
  /** Epoch ms of the approval. */
  at: number
  /** The submission approved; every approval of one submission carries the same id. */
  submission?: string
}

export type UnresolvedSendEvent =
  /** Saved before each approval; another submission's hold refuses it. */
  | { type: "held"; send: Omit<UnresolvedSend, "id"> }
  /** With `only`, only a hold that matches every field given goes. */
  | { type: "cleared"; only?: { address?: string; submission?: string } }

/** Another send's hold refused this one, or its own hold could not be saved. */
export const isHoldRefusal = (e: unknown): e is WalletError =>
  e instanceof WalletError && (e.code === "deposit.sendHeld" || e.code === "deposit.holdUnsaved")

/** One hold per account. */
const HOLD = "send"

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The hold after `e`: null removes it, undefined leaves it. */
export function unresolvedSendTransition(
  saved: UnresolvedSend | undefined,
  e: UnresolvedSendEvent,
): UnresolvedSend | null | undefined {
  if (e.type === "held") {
    if (saved && (!e.send.submission || saved.submission !== e.send.submission))
      throw new WalletError("deposit.sendHeld")
    return { ...e.send, id: HOLD }
  }
  if (!saved) return undefined
  const { only } = e
  if (only?.address && !same(saved.address, only.address)) return undefined
  if (only?.submission && saved.submission !== only.submission) return undefined
  return null
}

export interface UnresolvedSends {
  readonly ready: Promise<void>
  readonly view: ReadonlyStore<RecordSet<UnresolvedSend>>
  /** Resolves once saved; a refused hold rejects `deposit.sendHeld`, an unsaved one `holdUnsaved`. */
  apply(e: UnresolvedSendEvent): Promise<void>
}

/** The hold as the deposit screen reads it; `unreadable` while the store failed to open or read. */
export type UnresolvedSendState =
  | { status: "none" }
  | { status: "held"; send: UnresolvedSend }
  | { status: "unreadable" }
  | { status: "loading" }

export function unresolvedSendState(view: RecordSet<UnresolvedSend>): UnresolvedSendState {
  if (view.failed) return { status: "unreadable" }
  if (!view.loaded) return { status: "loading" }
  const [send] = view.records
  return send ? { status: "held", send } : { status: "none" }
}

/** New funding starts only once the saved holds are read and none stands. */
export const depositsOffered = (state: UnresolvedSendState): boolean => state.status === "none"

/**
 * The deposit that ended a hold: funds reached its address. A published address already has an
 * unfunded record from discovery, which proves nothing.
 */
export function holdArrival(
  send: Pick<UnresolvedSend, "address"> | undefined,
  deposits: readonly SipaDeposit[],
): SipaDeposit | undefined {
  if (!send) return undefined
  return deposits.find((r) => same(r.sipaAddress, send.address) && !isUnfundedSipaDeposit(r))
}

/** The account's hold, in its namespace. */
export function createUnresolvedSends({
  page,
  namespace,
  legacyKey,
}: {
  /** The page's database: the store's keys sit under `namespace`, the legacy marker at its root. */
  page: Database
  namespace: string
  /** The legacy marker's key, read at the first open; undefined when no address is known. */
  legacyKey?: () => string | undefined
}): UnresolvedSends {
  const prefix = `${namespace}acct/unresolved-send`
  const store = persistentStore<UnresolvedSend>(page, {
    prefix,
    version: 1,
    id: (r) => r.id,
    load: "all",
    migrate: (from, w) => migrateUnresolvedSends(from, w, { prefix, hold: HOLD, legacyKey }),
  })
  return {
    ready: store.ready,
    view: store.view,
    apply: async (e) => {
      const saving = store.ready.then(() =>
        page.write(async (w) => {
          const next = unresolvedSendTransition(await store.get(HOLD, w), e)
          if (next === null) await store.remove(HOLD, w)
          else if (next) await store.put(next, w)
        }),
      )
      if (e.type !== "held") return saving
      return saving.catch((err: unknown) => {
        if (isHoldRefusal(err)) throw err
        throw new WalletError("deposit.holdUnsaved", undefined, { cause: err })
      })
    },
  }
}
