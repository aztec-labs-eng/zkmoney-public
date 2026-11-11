import { migrateXmtpInbox } from "../storageMigrations/xmtpInbox"
import type { Database } from "./database"
import { loadRecords, persistentStore } from "./persistentStore"

/** What this device keeps about one XMTP inbox. */
export interface XmtpInboxRecord {
  inboxId: string
  /** The lowercase identity this device built an installation of the inbox for. */
  address?: string
  /** When this device last revoked one of the inbox's installations. */
  revokedAtMs?: number
}

/** The account's XMTP inboxes: which one a warm start can build, and the revoke rate limit. */
export interface XmtpInbox {
  /** Whether this device built an installation for `address`, so a warm start may find it. */
  built(address: string): Promise<boolean>
  markBuilt(address: string, inboxId: string): Promise<void>
  revokedAtMs(inboxId: string): Promise<number | undefined>
  /** Undefined clears the stamp. */
  setRevokedAtMs(inboxId: string, ms: number | undefined): Promise<void>
}

export function createXmtpInbox({ db }: { db: Database }): XmtpInbox {
  const prefix = "acct/xmtpInbox"
  const store = persistentStore<XmtpInboxRecord>(db, {
    prefix,
    version: 1,
    id: (record) => record.inboxId,
    migrate: (from, w) => migrateXmtpInbox(from, w, { prefix, legacy: db }),
    load: "all",
  })
  const change = (inboxId: string, patch: Partial<XmtpInboxRecord>) =>
    store.apply(inboxId, (current) => ({ ...current, ...patch, inboxId }))
  return {
    async built(address) {
      const lower = address.toLowerCase()
      return (await loadRecords(store.view)).some((record) => record.address === lower)
    },
    markBuilt: async (address, inboxId) =>
      void (await change(inboxId, { address: address.toLowerCase() })),
    revokedAtMs: async (inboxId) => (await store.get(inboxId))?.revokedAtMs,
    setRevokedAtMs: async (inboxId, ms) => void (await change(inboxId, { revokedAtMs: ms })),
  }
}
