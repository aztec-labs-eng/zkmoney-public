/**
 * An ended operation as the notifications panel lists it, read straight off the record: nothing is
 * written for it, so the list follows the store and the active scope with nothing to reconcile.
 */
import type { AppNotificationEntry, OperationRecord } from "@obsidion/front-core"
import { sponsorshipErrorCopy } from "../allowance/sponsorshipError"
import { flowCopy } from "./operationCopy"

const PREFIX = "operation:"

export function operationEntryId(operationId: string): string {
  return `${PREFIX}${operationId}`
}

/** The operation an entry of {@link operationEntry} stands for; undefined for any other entry. */
export function operationIdOf(entryId: string): string | undefined {
  return entryId.startsWith(PREFIX) ? entryId.slice(PREFIX.length) : undefined
}

/** The context each flow's screen reports its failures under, which the allowance copy keys on. */
const REPORT_CONTEXT: Partial<Record<string, string>> = {
  "send": "contact:send",
  "withdraw": "withdraw:submit",
  "paylink-create": "paylink:create",
  "deposit": "deposit:resolve",
  "request-link": "request-link:create",
}

function failureText(record: OperationRecord, copy: ReturnType<typeof flowCopy>): string {
  if (record.error !== undefined) {
    const named = copy.describeError?.(record.error)
    if (named) return named
    const refused = sponsorshipErrorCopy(record.error, REPORT_CONTEXT[record.flow] ?? record.flow)
    if (refused) return `${record.summary}. ${refused.message}`
  }
  return `${record.summary}. ${(record.cause && copy.causes[record.cause]) || copy.thrown}`
}

/**
 * The entry for an ended operation; null while it runs, and for a flow whose own record's rows
 * report its ending, or one with no settled row to show.
 */
export function operationEntry(record: OperationRecord): AppNotificationEntry | null {
  const copy = flowCopy(record.flow)
  if (record.endedAt === undefined || copy.outcome === "record") return null
  // A cause the flow declares as `null` is not news: the next load takes it up again.
  if (record.state === "failed" && record.cause && copy.causes[record.cause] === null) return null
  const id = operationEntryId(record.operationId)
  const base = {
    id,
    sourceId: id,
    producer: "operation",
    domain: "transaction",
    timestampMs: record.endedAt,
    read: record.readAt !== undefined,
    readAt: record.readAt,
    dismissedAt: record.dismissedAt,
  }
  if (record.state === "settled") {
    if (!copy.settled) return null
    return {
      ...base,
      title: copy.settled,
      description: record.summary,
      systemIcon: "checkmark.circle.fill",
      severity: "success",
      target: record.txHash
        ? { type: "transfer.txDetail", txHash: record.txHash }
        : { type: "transfer.pending" },
    }
  }
  return {
    ...base,
    title: copy.failed,
    description: failureText(record, copy),
    systemIcon: "exclamationmark.triangle.fill",
    severity: "error",
    target: { type: "transfer.pending" },
  }
}
