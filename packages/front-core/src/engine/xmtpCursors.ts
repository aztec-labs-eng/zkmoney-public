import { migrateXmtpCursors } from "../storageMigrations/xmtpCursors"
import type { Database } from "./database"
import { encodeRecord, loadRecords, persistentStore } from "./persistentStore"

/** How far the inbox read one conversation, under the installation that read it. */
export interface XmtpCursor {
  conversationId: string
  /** The newest message handled, in ns; 0 when none was. */
  sentNs: bigint
  installationId: string | null
  /** The next full sweep starts here: the last one ran out of request budget in it. */
  resume?: true
}

/** The inbox's read position: each conversation's cursor, all bound to one installation. */
export interface XmtpCursorMap {
  installationId: string | null
  cursors: Record<string, bigint>
  resumeConversationId?: string
}

/** The inbox driver's cursors, one record per conversation. */
export interface XmtpCursors {
  /** Rejects when the saved cursors do not read. */
  load(): Promise<XmtpCursorMap>
  /** Saves `map` in one write. */
  save(map: XmtpCursorMap): Promise<void>
}

const PREFIX = "acct/xmtpCursors"

export function cursorRecords(map: XmtpCursorMap): XmtpCursor[] {
  const ids = new Set(Object.keys(map.cursors))
  if (map.resumeConversationId !== undefined) ids.add(map.resumeConversationId)
  return [...ids].map((conversationId) => ({
    conversationId,
    sentNs: map.cursors[conversationId] ?? 0n,
    installationId: map.installationId,
    ...(conversationId === map.resumeConversationId ? { resume: true as const } : {}),
  }))
}

function cursorMap(records: readonly XmtpCursor[]): XmtpCursorMap {
  return {
    installationId: records[0]?.installationId ?? null,
    cursors: Object.fromEntries(
      records.filter((r) => r.sentNs > 0n).map((r) => [r.conversationId, r.sentNs]),
    ),
    resumeConversationId: records.find((r) => r.resume)?.conversationId,
  }
}

export function createXmtpCursors({ db }: { db: Database }): XmtpCursors {
  const store = persistentStore<XmtpCursor>(db, {
    prefix: PREFIX,
    version: 1,
    id: (cursor) => cursor.conversationId,
    migrate: (from, w) => migrateXmtpCursors(from, w, PREFIX),
    load: "all",
  })
  return {
    load: async () => cursorMap(await loadRecords(store.view)),
    async save(map) {
      await store.ready
      await db.write(async (w) => {
        const saved = new Map(
          (await db.range(`${PREFIX}/`)).map(([key, raw]) => [key.slice(PREFIX.length + 1), raw]),
        )
        for (const cursor of cursorRecords(map)) {
          if (saved.get(cursor.conversationId) !== encodeRecord(cursor)) await store.put(cursor, w)
          saved.delete(cursor.conversationId)
        }
        for (const id of saved.keys()) await store.remove(id, w)
      })
    },
  }
}
