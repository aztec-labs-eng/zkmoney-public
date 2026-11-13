/**
 * Once per page load, account and source: the activity this browser kept for the account on retired
 * rollups, or a source generation rebuilt, carried into this rollup's stores. An account switch during
 * the read drops the import, and the next boot tries again; the writes hold the session lock, so no
 * switch lands between them.
 */
import {
  importHistoricActivity,
  importHistoricContacts,
  savingsHoldingRef,
  task,
} from "@obsidion/front-core"
import type {
  Contacts,
  HistoricActivityImported,
  RetiredDatabase,
  Task,
  Service,
} from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import type { Session, SessionDeps } from "../../session/session"
import { stillCommitted } from "../../session/stillCommitted"

// eslint-disable-next-line no-restricted-syntax -- debt
const imports = new Map<string, Promise<HistoricActivityImported | null>>()

/** A database from elsewhere, read only when its own marker is absent. */
export interface HistoricSource {
  key: string
  read(): Promise<RetiredDatabase>
}

type ImportSession = Pick<SessionDeps, "device" | "namespace" | "sessionLock"> &
  Pick<Session, "transfers" | "sipaDeposits" | "withdrawals" | "moves" | "page">

/** This browser's retired databases, or `from` in their place. */
export function importHistoricActivityOnce(
  session: ImportSession,
  storageId: string,
  from?: HistoricSource,
): Promise<HistoricActivityImported | null> {
  const memo = `${from?.key ?? ""}\n${storageId}`
  let run = imports.get(memo)
  if (!run) {
    run = (async () => {
      // A retired move counts in the current Sky holding's ledger: the upgrade carried its shares.
      const sky = savingsHoldingRef(
        await session.page.chain.holdings.read(),
        session.page.config.holdings,
      )
      return importHistoricActivity({
        storage: webStorage,
        key: from?.key,
        readOtherDatabases: from
          ? async (read) => [read(await from.read())]
          : (read) => webStorage.readOtherDatabases(read),
        transactions: session.transfers,
        sipaDeposits: session.sipaDeposits,
        withdrawals: session.withdrawals,
        moves: session.moves,
        ...(sky ? { skyHolding: sky } : {}),
        now: session.page.now,
        ownsStorage: () => stillCommitted(session),
        holdSession: session.sessionLock,
      })
    })()
    imports.set(memo, run)
    run.catch(() => {
      if (imports.get(memo) === run) imports.delete(memo)
    })
  }
  return run
}

/**
 * The activity and contacts this browser kept for the account on retired rollups, once per session;
 * a failed import is tried again next boot. They wait for the wallet: the rows carry its network.
 */
export function historicImports(
  wallet: Service<unknown>,
  { storageId, contacts }: { storageId: string; contacts: Contacts },
  own: ImportSession,
  imports = {
    activity: (storageId: string) => importHistoricActivityOnce(own, storageId),
    contacts: (_storageId: string, contacts: Contacts) =>
      importHistoricContacts({
        storage: webStorage,
        readOtherDatabases: (read) => webStorage.readOtherDatabases(read),
        contacts,
        ownsStorage: () => stillCommitted(own),
        holdSession: own.sessionLock,
      }),
  },
): Task[] {
  return [
    task("historicActivity", {
      needs: { wallet },
      after: {
        firstBalance: true,
        depositsReplayed: true,
        movesReplayed: true,
        historyAtHead: true,
      },
      every: "once",
      run: async () => void (await imports.activity(storageId)),
    }),
    task("historicContacts", {
      needs: { wallet },
      every: "once",
      run: async () => void (await imports.contacts(storageId, contacts)),
    }),
  ]
}
