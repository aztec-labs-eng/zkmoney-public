import { selectNotifications, type OperationRecord } from "@obsidion/front-core"
import { pageSessionDeps } from "../../src/app/sessionDeps"
import { activeNamespace, openedSession, switchSession } from "../../src/session/session"
import { testCore, testPage } from "./page"
import { listsEnding, operationText } from "../../src/features/operations/operationEntries"

/** A `local` operation this page runs, as a flow's `runOperation` holds it; resolves to its end. */
export async function startTabBoundOperation(
  operationId = "op-test",
  flow = "withdraw",
): Promise<() => Promise<void>> {
  const operations = testOperations()
  await operations.begin({ operationId, flow, summary: "$25 to Ethereum" })
  return () => operations.remove(operationId)
}

/** The open session's record of `operationId`, as committed. */
export const operationRecord = (operationId: string | undefined) =>
  testOperations()
    .view.get()
    .records.find((r) => r.operationId === operationId)

/** The panel's entry for an ended operation, with its words. */
export function operationEntry(record: OperationRecord) {
  if (!listsEnding(record)) return null
  const none = { records: [], hydrated: true }
  const [entry] = selectNotifications(
    {
      rows: [],
      links: [],
      oldVersionWithdrawals: [],
      deposits: { records: [], loaded: true, failed: false },
      withdrawals: none,
      bridgeIns: none,
      upgrades: { items: [], recipients: new Set<string>(), loaded: true },
      upgradePricing: { settled: true },
      processing: new Map(),
      registrations: [],
      operations: { ended: [record], running: [] },
      loaded: true,
    },
    new Map(),
    new Map(),
    0,
  )
  return entry ? { ...entry, ...operationText(record) } : null
}

/** The open session, opening the page's session if none is. */
export const testSession = () =>
  openedSession.get() ??
  switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage()))

/** The open session's operations store. */
export const testOperations = () => testSession().operations
