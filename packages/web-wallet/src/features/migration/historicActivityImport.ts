/**
 * Once per page load, account and source: the activity this browser kept for the account on retired
 * rollups, or a source generation rebuilt, carried into this rollup's stores. An account switch during
 * the read drops the import, and the next boot tries again; the writes hold the session lock, so no
 * switch lands between them.
 */
import {
  ContactStorage,
  importHistoricActivity,
  importHistoricContacts,
  SIPADepositStore,
  WithdrawalStorage,
  type HistoricActivityImported,
  type RetiredDatabase,
} from "@obsidion/front-core"
import { getActiveStorageId, withSessionLock } from "../../platform/storage/activeStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { session } from "../../platform/session"
import { getSavingsMoveStore } from "../savings/savingsMoveStore"

const imports = new Map<string, Promise<HistoricActivityImported | null>>()

/** A database from elsewhere, read only when its own marker is absent. */
export interface HistoricSource {
  key: string
  read(): Promise<RetiredDatabase>
}

/** This browser's retired databases, or `from` in their place. */
export function importHistoricActivityOnce(
  from?: HistoricSource,
): Promise<HistoricActivityImported | null> {
  const storageId = getActiveStorageId()
  if (!storageId) return Promise.resolve(null)
  const memo = `${from?.key ?? ""}\n${storageId}`
  let run = imports.get(memo)
  if (!run) {
    run = importHistoricActivity({
      storage: webStorage,
      key: from?.key,
      readOtherDatabases: from
        ? async (read) => [read(await from.read())]
        : (read) => webStorage.readOtherDatabases(read),
      transactions: session().activity,
      sipaDeposits: SIPADepositStore.get(webStorage),
      withdrawals: WithdrawalStorage.get(webStorage),
      savingsMoves: getSavingsMoveStore(),
      ownsStorage: () => getActiveStorageId() === storageId,
      holdSession: withSessionLock,
    })
    imports.set(memo, run)
    run.catch(() => {
      if (imports.get(memo) === run) imports.delete(memo)
    })
  }
  return run
}

const contactImports = new Map<string, Promise<number | null>>()

/** The contacts this browser kept for the account on retired rollups, once per page load and account. */
export function importHistoricContactsOnce(): Promise<number | null> {
  const storageId = getActiveStorageId()
  if (!storageId) return Promise.resolve(null)
  let run = contactImports.get(storageId)
  if (!run) {
    run = importHistoricContacts({
      storage: webStorage,
      readOtherDatabases: (read) => webStorage.readOtherDatabases(read),
      contacts: ContactStorage.get(),
      ownsStorage: () => getActiveStorageId() === storageId,
      holdSession: withSessionLock,
    })
    contactImports.set(storageId, run)
    run.catch(() => {
      if (contactImports.get(storageId) === run) contactImports.delete(storageId)
    })
  }
  return run
}
