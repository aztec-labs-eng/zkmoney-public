/**
 * Storage migration: the transfer-scan and paylink-rescan cursors older builds kept at the
 * namespace's root, copied under `acct/` on first read. Remove when no supported build older than
 * the one that keeps them under `acct/` remains.
 */
import type { Database } from "../engine/database"

/** Where older builds kept each scan's cursor; the key after it is the same in both layouts. */
export const LEGACY_TRANSFER_SCAN_CURSOR = "@obsidion/transfer-scan/cursor/v1/"
export const LEGACY_PAYLINK_RESCAN_CURSOR = "@obsidion/paylink-rescan/cursor/v2/"

/**
 * The cursor at `key`. While none is there, an older build's cursor at `older` is copied to `key`
 * in one write and returned; `older` is never written.
 */
export async function carriedScanCursor(
  db: Pick<Database, "getMany" | "write">,
  key: string,
  older: string,
): Promise<string | undefined> {
  const [saved, old] = await db.getMany([key, older])
  if (saved !== undefined || old === undefined) return saved
  return db.write(async (w) => {
    const value = (await w.get(key)) ?? old
    w.put(key, value)
    return value
  })
}
