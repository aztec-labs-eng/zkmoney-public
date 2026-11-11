/**
 * Storage migration: the inbox cursors older builds kept as one map. Remove when no supported build
 * older than the one that writes `acct/xmtpCursors` v1 remains.
 */
import type { Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { encodeRecord } from "../engine/persistentStore"
import { cursorRecords } from "../engine/xmtpCursors"

export const LEGACY_XMTP_CURSORS_KEY = "@obsidion/xmtp-inbox-driver/cursors/v1"

/** A saved cursor: a JSON number, or a decimal string past 2^53. */
function nsOf(value: unknown): bigint | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined
  try {
    return BigInt(value)
  } catch {
    return undefined // the decode boundary: a cursor that does not read is dropped
  }
}

/**
 * Version 1 carries each conversation's cursor, the installation and the sweep's resume point, so
 * the inbox replays nothing. A map that does not parse fails the open and keeps its bytes: a replay
 * would re-add auto-added payers the user deleted. A cursor that does not read is dropped, as older
 * builds read it, and only its conversation replays. The map stays for one release.
 */
export async function migrateXmtpCursors(
  from: number | undefined,
  w: Write,
  prefix: string,
): Promise<void> {
  if (from !== undefined) throw new WalletError("invariant", `xmtpCursors: unknown version ${from}`)
  const raw = await w.get(LEGACY_XMTP_CURSORS_KEY)
  if (raw === undefined) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined // the decode boundary: unreadable text fails below
  }
  const map = parsed as {
    installationId?: unknown
    cursors?: unknown
    resumeConversationId?: unknown
  }
  if (!map || typeof map !== "object" || !map.cursors || typeof map.cursors !== "object")
    throw new WalletError("unknown", "xmtpCursors: the saved cursors do not parse")
  const cursors: Record<string, bigint> = {}
  for (const [id, value] of Object.entries(map.cursors)) {
    const ns = nsOf(value)
    if (ns !== undefined) cursors[id] = ns
  }
  const records = cursorRecords({
    installationId: typeof map.installationId === "string" ? map.installationId : null,
    cursors,
    resumeConversationId:
      typeof map.resumeConversationId === "string" ? map.resumeConversationId : undefined,
  })
  for (const cursor of records) w.put(`${prefix}/${cursor.conversationId}`, encodeRecord(cursor))
}
