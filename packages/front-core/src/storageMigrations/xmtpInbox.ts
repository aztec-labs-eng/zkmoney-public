/**
 * Storage migration: the XMTP inbox-id cache and revoke stamps older builds kept one key per
 * identity and per inbox. Remove when no supported build older than the one that writes
 * `acct/xmtpInbox` v1 remains.
 */
import type { Database, Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { encodeRecord } from "../engine/persistentStore"
import type { XmtpInboxRecord } from "../engine/xmtpInbox"

/** Older builds' key prefixes: the lowercase identity, or the inbox id, follows each. */
export const LEGACY_INBOX_ID_PREFIX = "xmtp.v2.inboxId."
export const LEGACY_REVOKED_AT_PREFIX = "xmtp.v2.revokedAt."

/**
 * Version 1 carries, per inbox, the identity this device built an installation for and the revoke
 * stamp. Without the identity an upgraded device cold-starts, and at the installation cap that
 * revokes the oldest installation, which may be this one. A key that does not read is dropped. The
 * keys stay for one release.
 */
export async function migrateXmtpInbox(
  from: number | undefined,
  w: Write,
  { prefix, legacy }: { prefix: string; legacy: Pick<Database, "range"> },
): Promise<void> {
  if (from !== undefined) throw new WalletError("invariant", `xmtpInbox: unknown version ${from}`)
  const inboxes = new Map<string, XmtpInboxRecord>()
  const merge = (inboxId: string, patch: Partial<XmtpInboxRecord>) => {
    if (!inboxId || inboxId.includes("/")) return
    inboxes.set(inboxId, { ...inboxes.get(inboxId), ...patch, inboxId })
  }
  for (const [key, inboxId] of await legacy.range(LEGACY_INBOX_ID_PREFIX)) {
    const address = key.slice(LEGACY_INBOX_ID_PREFIX.length)
    if (address) merge(inboxId, { address: address.toLowerCase() })
  }
  for (const [key, raw] of await legacy.range(LEGACY_REVOKED_AT_PREFIX)) {
    const revokedAtMs = Number(raw)
    if (Number.isFinite(revokedAtMs) && revokedAtMs > 0)
      merge(key.slice(LEGACY_REVOKED_AT_PREFIX.length), { revokedAtMs })
  }
  for (const record of inboxes.values()) w.put(`${prefix}/${record.inboxId}`, encodeRecord(record))
}
