import { useEffect, useSyncExternalStore } from "react"
import { BackupRotationStore, type BackupRotationRecord } from "@obsidion/front-core"
import { backupPasskeySettingsEnabled } from "../../config/features"
import { createExternalState } from "../../lib/externalState"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

/** The saved records; `loading` until the first read lands, `unreadable` while storage refuses to be read. */
type Records = readonly BackupRotationRecord[] | "loading" | "unreadable"

/** A record, none, or why none can be told yet. */
export type BackupRotationState = BackupRotationRecord | null | "loading" | "unreadable"

let store: BackupRotationStore | undefined
const records = createExternalState<Records>("loading")

function read(from: BackupRotationStore): void {
  from.list().then(
    (next) => records.set(next),
    () => records.set("unreadable"),
  )
}

/** The signed-in account's pending rotation, one store per page load. */
export function getBackupRotationStore(): BackupRotationStore {
  if (!store) {
    store = new BackupRotationStore(webStorage)
    store.onChanged((next) => records.set(next))
    read(store)
  }
  return store
}

/** Reads the saved records again after a read failed. */
export function rereadBackupRotation(): void {
  if (store) read(store)
}

/**
 * The pending rotation, if any: null once a read found none (or the feature is off), `loading`
 * before the first read lands and `unreadable` while the saved records cannot be read; no add may
 * start in either. With `owner` only that L1 account's record counts; without it any account's
 * does, for a surface that has not read the account yet.
 */
export function useBackupRotation(owner?: string): BackupRotationState {
  useEffect(() => {
    if (backupPasskeySettingsEnabled) getBackupRotationStore()
  }, [])
  const current = useSyncExternalStore(records.subscribe, records.get, records.get)
  if (!backupPasskeySettingsEnabled) return null
  if (typeof current === "string") return current
  if (owner === undefined) return current[0] ?? null
  const key = owner.toLowerCase()
  return current.find((record) => record.owner.toLowerCase() === key) ?? null
}

/** Test seam: drops the page's store so the next read builds one over the current storage. */
export function resetBackupRotationStoreForTests(): void {
  store = undefined
  records.set("loading")
}
