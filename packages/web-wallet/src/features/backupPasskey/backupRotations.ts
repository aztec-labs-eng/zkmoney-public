import {
  WalletError,
  balanceMoving,
  memoryStore,
  rerootPending,
  useStore,
  type BackupRotationRecord,
  type BackupRotations,
  type RecordSet,
} from "@obsidion/front-core"
import { useSession, type Session } from "../../session/session"

/** The saved records; `loading` until the first read lands, `unreadable` once a read failed. */
export type SavedRotations = readonly BackupRotationRecord[] | "loading" | "unreadable"

/** A record, none, or why none can be told yet. */
export type BackupRotationState = BackupRotationRecord | null | "loading" | "unreadable"

const NO_ROTATIONS = memoryStore<RecordSet<BackupRotationRecord>>({
  records: [],
  loaded: true,
  failed: false,
}).readonly

/** The account's rotations; a visitor has none. */
export const rotationView = (open: Pick<Session, "backupRotations">) =>
  open.backupRotations?.view ?? NO_ROTATIONS

export const savedRotations = ({
  records,
  loaded,
  failed,
}: RecordSet<BackupRotationRecord>): SavedRotations =>
  failed ? "unreadable" : loaded ? records : "loading"

/** The account's rotations, for flows only an account reaches. */
export function accountRotations(open: Pick<Session, "backupRotations">): BackupRotations {
  if (!open.backupRotations) throw new WalletError("wallet.notReady", "no account session")
  return open.backupRotations
}

/** Every rotation record of the account, kept current, whatever the settings flag says. */
export const useBackupRotations = (): SavedRotations =>
  useStore(rotationView(useSession()), savedRotations)

/**
 * The pending rotation, if any: null once a read found none, `loading` before the first read lands
 * and `unreadable` once the saved records could not be read; no add may start in either. With
 * `owner` only that L1 account's record counts; without it any account's does, for a surface that
 * has not read the account yet.
 */
export function useBackupRotation(owner?: string): BackupRotationState {
  const current = useBackupRotations()
  if (typeof current === "string") return current
  if (owner === undefined) return current[0] ?? null
  const key = owner.toLowerCase()
  return current.find((record) => record.owner.toLowerCase() === key) ?? null
}

/** {@link rerootPending} over the account's records; undefined while they are not read, or unreadable. */
export function useRerootPending(address: string | undefined): boolean | undefined {
  const current = useBackupRotations()
  return typeof current === "string" ? undefined : rerootPending(current, address)
}

/**
 * {@link balanceMoving} over the account's records. Records not read yet, or unreadable, pause
 * nothing: sends are never blocked on storage the wallet cannot read, and no rotation runs over it.
 */
export function useBalanceMoving(address: string | undefined): boolean {
  const current = useBackupRotations()
  return typeof current !== "string" && balanceMoving(current, address)
}
