import type { Address } from "viem"
import { migrateReceiveCodes } from "../storageMigrations/receiveCodes"
import type { Database } from "./database"
import { persistentStore, type RecordSet } from "./persistentStore"
import type { ReadonlyStore } from "./store"

/** Receive's live code: one minted request per address, kept until it is paid. */
export interface ReceiveCode {
  requestId: string
  url: string
  /** Dollars; 0 is any amount. */
  amount: number
  note?: string
  address?: Address
  /** Chain epoch day the address was derived on. */
  day?: number
  expiresAt: number
  /** The L2 address the code pins. */
  requester?: string
}

/** A code as saved, by `<networkId>.<tag>`. */
export interface StoredReceiveCode {
  id: string
  code: ReceiveCode
}

export function isReceiveCode(v: unknown): v is ReceiveCode {
  const c = v as ReceiveCode
  return (
    typeof c?.requestId === "string" && typeof c.url === "string" && typeof c.expiresAt === "number"
  )
}

export interface ReceiveCodes {
  readonly view: ReadonlyStore<RecordSet<StoredReceiveCode>>
  /** The code saved under `id`; null for none, or one that does not read as a code. */
  get(id: string): Promise<ReceiveCode | null>
  /** Resolves once committed. */
  put(id: string, code: ReceiveCode): Promise<void>
}

/** The account's Receive codes. `legacy` is the page's database, which holds older builds' codes. */
export function createReceiveCodes({
  db,
  legacy,
}: {
  db: Database
  legacy: Pick<Database, "range">
}): ReceiveCodes {
  const prefix = "acct/receiveCodes"
  const store = persistentStore<StoredReceiveCode>(db, {
    prefix,
    version: 1,
    id: (code) => code.id,
    migrate: (from, w) => migrateReceiveCodes(from, w, { prefix, legacy }),
    load: "all",
  })
  return {
    view: store.view,
    async get(id) {
      const saved = await store.get(id)
      return saved && isReceiveCode(saved.code) ? saved.code : null
    },
    put: (id, code) => store.put({ id, code }),
  }
}
