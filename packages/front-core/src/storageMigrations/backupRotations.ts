/**
 * Storage migration: the backup rotations older builds kept in one `RecordStorage` blob. Remove
 * when no supported build older than the one that writes `acct/backupRotations` v1 remains.
 */
import type { Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { carryRecordBlob } from "./recordBlob"

export const BACKUP_ROTATION_KEY = "obsidion_backup_rotation"

/**
 * Version 1 carries every record of the blob as saved, its sealed envelopes included. A blob that
 * does not parse, or one record that fails `toRecord`, fails the open with nothing written: a
 * rotation holds funds in flight. The blob stays for one release.
 */
export async function migrateBackupRotations<R>(
  from: number | undefined,
  w: Write,
  store: { prefix: string; id(record: R): string },
  toRecord: (value: unknown, key: string) => R,
): Promise<void> {
  if (from !== undefined)
    throw new WalletError("invariant", `backupRotations: unknown version ${from}`)
  await carryRecordBlob(w, BACKUP_ROTATION_KEY, store, toRecord)
}
