/**
 * Every user-started transaction runs through {@link runOperation}, as one record of its session's
 * `operations` store, and everything that says whether the tab may close reads it.
 */
import {
  bestEffort,
  memoryStore,
  TxInFlightError,
  userFlowActive,
  useStore,
  WalletError,
  type ErrorCode,
  type OperationEvent,
  type OperationKind,
  type OperationRecord,
  type Operations,
  type RecordSet,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { useState } from "react"
import { openedSession, useSession, type Session } from "../../session/session"
import { flowCopy } from "./operationCopy"

/** Named as the analytics `flow` prop, so events about an operation forward as they are. */
export type OperationFlow =
  | "send"
  | "withdraw"
  | "paylink-create"
  | "paylink-claim"
  | "paylink-claim-l1"
  | "paylink-reclaim"
  | "deposit"
  | "request-link"
  | "migration"
  | "migration-arrival"
  | "savings"

/** The user stopped the flow before anything was sent: a closed passkey prompt, or a cancel. */
export function isFlowCancelled(err: unknown): boolean {
  return isPasskeyCancelled(err) || (err instanceof Error && err.message === "Cancelled")
}

/** The `WalletError` code an error carries, its own or its cause's: a deadline wraps its timeout. */
export function failureCodeOf(e: unknown): ErrorCode {
  if (e instanceof WalletError) return e.code
  return e instanceof Error && e.cause !== undefined ? failureCodeOf(e.cause) : "unknown"
}

/** A failure a later try may get past: a read that timed out or could not answer. */
export function retryableFailure(code: ErrorCode | undefined): boolean {
  return code === "timeout" || code === "paylink.voucherUnread"
}

export type OperationInput = {
  operationId: string
  flow: OperationFlow
  summary: string
  /** The operation this one runs inside. */
  parent?: string
} & OperationKind

export interface OperationHandle {
  operationId: string
  /** Renames the operation once the flow has read what the summary names, e.g. a link's amount. */
  describe(summary: string): void
  /** Saves what the transfer's row shows: the operation is the transfer's record. */
  transfer(transfer: Extract<OperationEvent, { type: "transfer" }>["transfer"]): Promise<void>
  /**
   * Saves the hash before the node takes the tx, for a flow whose own record saved it already;
   * a flow with a record of its own saves both in one write instead.
   */
  sent(txHash: string): Promise<void>
  /**
   * The flow returns with its transaction sent but not yet included: the chain settles the record
   * instead of the flow. Only `runBurn` returns this way; other flows throw `TxInFlightError`.
   */
  leaveToChain(txHash: string | undefined): void
}

/**
 * Run `run` as one user operation, behind the single-flight gate: it is `local` until it holds the
 * hash, and settles when `run` resolves. A failure before proving began, or a cancel, sent
 * nothing, so the record goes; a transfer's record stays failed, quietly, unless cancelled. A
 * `TxInFlightError` leaves it `sent` for the chain; any other failure is definite, and fails it
 * even once sent. The record begins ahead of the gate, so the bell lists the operation while a
 * background proof finishes first.
 */
export function runOperation<T>(
  session: Pick<Session, "operations" | "page">,
  input: OperationInput,
  run: (op: OperationHandle) => Promise<T>,
  txHashOf?: (result: T) => string | undefined,
  opts?: RunOptions,
): Promise<T> {
  const { operations, page } = session
  const begun = operations.begin(input)
  // Awaited inside the gate; this only keeps a failed write from reading as unhandled meanwhile.
  void bestEffort("unknown", begun)
  return page.prover.runUserFlow(async () => {
    await begun
    return operate(operations, input.operationId, run, txHashOf, opts)
  })
}

/**
 * Run `run` as one user operation that is NOT behind the gate: the bell lists it and it keeps the
 * tab, as {@link runOperation} does, but it raises no user flow. Use it for a long flow that sends
 * each transaction as its own gated step, such as an upgrade's send pass that waits for chain
 * events: a user flow held for that time would stop every background proof. `run` may run a user
 * flow for its own prompts, and may send through {@link runBackgroundOperation} outside of that
 * flow. It ends as a user operation would.
 */
export async function runListedOperation<T>(
  session: Pick<Session, "operations">,
  input: OperationInput,
  run: (op: OperationHandle) => Promise<T>,
): Promise<T> {
  await session.operations.begin(input)
  return operate(session.operations, input.operationId, run)
}

/**
 * Run `run` as one automatic operation no user started, such as an upgrade's transaction step: it
 * waits its turn on the background proving reservation, and its record is background, so nothing
 * lists it and leaving the page loses nothing. It ends as a user operation would.
 */
export function runBackgroundOperation<T>(
  session: Pick<Session, "operations" | "page">,
  input: OperationInput,
  run: (op: OperationHandle) => Promise<T>,
): Promise<T> {
  const { operations, page } = session
  return page.prover.runBackground(async () => {
    await operations.begin({ ...input, background: true })
    return operate(operations, input.operationId, run)
  })
}

export interface RunOptions {
  /**
   * A retry no user asked for, such as Home's automatic claim: a failure before its proof that a
   * later try may get past leaves no record, so the retries do not fill the history.
   */
  dropRetryable?: boolean
}

/** Runs a begun operation's flow and ends its record by how the flow ended. */
async function operate<T>(
  operations: Operations,
  operationId: string,
  run: (op: OperationHandle) => Promise<T>,
  txHashOf?: (result: T) => string | undefined,
  opts?: RunOptions,
): Promise<T> {
  const apply = (event: OperationEvent) => operations.apply(operationId, event).catch(console.warn)
  /** The event, strictly: an operation that did not save it must not let the tx go out. */
  const strict = async (event: OperationEvent) => {
    if (!(await operations.apply(operationId, event)))
      throw new WalletError("invariant", `operation: no record for its ${event.type}`)
  }
  // On chain but unsettled. A hash the flow's record failed to save still takes it to `sent`.
  const toChain = async (txHash: string | undefined) => {
    if (txHash) await apply({ type: "sent", txHash })
  }
  let inFlight: { txHash: string | undefined } | undefined
  try {
    const result = await run({
      operationId,
      describe: (summary) => void apply({ type: "described", summary }),
      transfer: (transfer) => strict({ type: "transfer", transfer }),
      sent: (txHash) => strict({ type: "sent", txHash }),
      leaveToChain: (txHash) => void (inFlight = { txHash }),
    })
    if (inFlight) await toChain(inFlight.txHash)
    else await apply({ type: "settled", txHash: txHashOf?.(result), at: Date.now() })
    return result
  } catch (err) {
    const record = await bestEffort("unknown", operations.get(operationId))
    const message = err instanceof Error ? err.message : String(err)
    const failed = {
      type: "failed",
      error: message,
      failure: { code: failureCodeOf(err) },
      at: Date.now(),
    } as const
    if (err instanceof TxInFlightError) {
      await toChain(err.txHash)
    } else if (record?.state === "sent") {
      // The flow saw the chain turn it down: its message is the specific one.
      await apply(failed)
    } else if (record?.state === "local") {
      // Nothing was lost before the proof began (a closed passkey prompt, a failed read): the
      // flow's screen reports it, and the record goes, or a transfer's stays as its history. Once
      // the screen has handed off, the record is the only report left.
      const lost = record.provingStartedAt !== undefined || record.handedOffAt !== undefined
      const passing =
        !record.kind || (!!opts?.dropRetryable && retryableFailure(failed.failure.code))
      if (isFlowCancelled(err) || (!lost && passing)) {
        await operations.remove(operationId).catch(console.warn)
      } else {
        await apply({ ...failed, quiet: !lost })
      }
    }
    throw err
  } finally {
    operations.release(operationId)
  }
}

const NONE: Pick<Operations, "view" | "live" | "running" | "tabBound"> = {
  // eslint-disable-next-line no-restricted-syntax -- debt
  view: memoryStore<RecordSet<OperationRecord>>({ records: [], loaded: false, failed: false })
    .readonly,
  // eslint-disable-next-line no-restricted-syntax -- debt
  live: memoryStore<ReadonlySet<string>>(new Set()).readonly,
  // eslint-disable-next-line no-restricted-syntax -- debt
  running: memoryStore<readonly OperationRecord[]>([]).readonly,
  // eslint-disable-next-line no-restricted-syntax -- debt
  tabBound: memoryStore<OperationRecord | undefined>(undefined).readonly,
}

/** The open session's operations; none before boot opens one. */
const useOperations = () => useStore(openedSession)?.operations ?? NONE

export function useOperationsInProgress(): readonly OperationRecord[] {
  return useStore(useOperations().running)
}

export function useTabBoundOperation(): OperationRecord | undefined {
  return useStore(useOperations().tabBound)
}

/** Whether a user flow runs: transaction buttons disable instead of letting `sendTx` throw. */
export const useUserFlowActive = (): boolean =>
  useStore(useSession().page.prover.state, userFlowActive)

export function useLeavingLosesTransaction(): boolean {
  return !!useTabBoundOperation()
}

/** Whether the tab may close for one operation: `keep` while this page proves it, `safe` once sent. */
export type TabLine = "keep" | "safe"

export function tabLineOf(record: OperationRecord | null, live: boolean): TabLine | undefined {
  if (record?.state === "sent") return "safe"
  return record?.state === "local" && live ? "keep" : undefined
}

/** How long the keep-open notice says the tab may close before it goes. */
export const SAFE_SHOWN_MS = 4000

const NO_CLOCK = memoryStore(0).readonly

/**
 * The operation this tab proves, and its tab line: `keep` while it binds the tab, then `safe` for a
 * moment once it is sent. A failed or cancelled one shows nothing: its flow and the bell report it.
 */
export function useKeepOpenNotice(): { operation: OperationRecord; line: TabLine } | undefined {
  const { operations, page } = useSession()
  const bound = useStore(operations.tabBound)
  const { records } = useStore(operations.view)
  const [shown, show] = useState<{ id: string; safeAt?: number }>()
  if (bound && bound.operationId !== shown?.id) show({ id: bound.operationId })
  const operation = bound ?? records.find((r) => r.operationId === shown?.id)
  const sent = !bound && (operation?.state === "sent" || operation?.state === "settled")
  if (sent && shown?.safeAt === undefined) show({ id: operation.operationId, safeAt: page.now() })
  const now = useStore(shown?.safeAt === undefined ? NO_CLOCK : page.seconds)
  const safe = sent && (shown?.safeAt === undefined || now - shown.safeAt < SAFE_SHOWN_MS)
  if (!bound && shown && !safe) show(undefined)
  if (bound) return { operation: bound, line: "keep" }
  return operation && safe ? { operation, line: "safe" } : undefined
}

export function useTabLine(operationId: string | undefined): TabLine | undefined {
  const operations = useOperations()
  const { records } = useStore(operations.view)
  const live = useStore(operations.live)
  if (!operationId) return undefined
  return tabLineOf(
    records.find((r) => r.operationId === operationId) ?? null,
    live.has(operationId),
  )
}

/**
 * The outermost operation a flow in this page runs: a live record with no parent, or whose parent
 * no longer runs. A child such as a claim's deposit address shows under it.
 */
export function currentOperation(
  records: readonly OperationRecord[],
  live: ReadonlySet<string>,
): OperationRecord | undefined {
  return records.find(
    (r) => !r.background && live.has(r.operationId) && (!r.parent || !live.has(r.parent)),
  )
}

export function useCurrentOperation(): OperationRecord | undefined {
  const operations = useOperations()
  return currentOperation(useStore(operations.running), useStore(operations.live))
}

/** A transaction button's label while another transaction proves, named after it. */
export function useBusyLabel(): string {
  const current = useCurrentOperation()
  return current ? flowCopy(current.flow).busy : "Another transaction in progress…"
}
