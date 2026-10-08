/**
 * Client for the desktop launcher's L1 submit bridge. The launcher injects
 * `window.__ZKMONEY_DESKTOP_BRIDGE__` into its locally-served index.html; the
 * hosted deployment never has it, so every entry point below no-ops there.
 *
 * The bridge exists because the launched Chrome profile has no wallet
 * extensions: the app POSTs a prepared L1 transaction to its own local server,
 * the launcher opens a helper page in the user's DEFAULT browser (where their
 * MetaMask lives), and the app polls until the helper reports the tx hash.
 */
import type { Hex } from "viem"

/** Where the launcher serves its settings page, which a desktop build renders from its own code. */
export const DESKTOP_SETTINGS_PATH = "/desktop-settings"

export interface DesktopL1Bridge {
  l1SubmitPath: string
  /** The launcher's endpoint-settings page, same origin. */
  settingsPath?: string
  /** Features this launcher supports; `recheck` = the helper asks for approval before each send. */
  capabilities: readonly string[]
}

interface SubmissionStatus {
  state:
    | "pending"
    | "checking"
    | "authorized"
    | "sending"
    | "refused"
    | "submitted"
    | "superseded"
    | "error"
  txHash?: Hex
  message?: string
  /** Recheck submissions: the number of the helper's latest approval request. */
  check?: number
}

/** The launcher predates the send check that this transfer requires. */
export class DesktopBridgeUpdateRequiredError extends Error {
  constructor() {
    super("Update zk.money Desktop to send this transfer from your browser wallet.")
    this.name = "DesktopBridgeUpdateRequiredError"
  }
}

/** zk.money Desktop holds a claimed send whose wallet prompt may still send, so no new checked transfer starts. */
export class DesktopSendOpenError extends Error {
  constructor() {
    super(
      "zk.money Desktop is still waiting on an earlier transfer from your browser wallet. Finish or cancel it there. If your wallet no longer shows it, restart zk.money Desktop.",
    )
    this.name = "DesktopSendOpenError"
  }
}

/** The injected recheck did not settle within its budget; the send was refused. */
export class DesktopRecheckTimeoutError extends Error {
  constructor() {
    super("Checking this transfer took too long.")
    this.name = "DesktopRecheckTimeoutError"
  }
}

/**
 * A recheck send was approved but no hash arrived: the wallet prompt opened under that approval may
 * still send, so the caller must treat the target as possibly funded. `cause` is whatever ended the
 * wait (a later refusal, the deadline, supersede, expiry, a failed poll).
 */
export class DesktopSendUnresolvedError extends Error {
  constructor(cause: unknown) {
    super("Your browser wallet may still send this transfer. If it does, zk.money detects it.", {
      cause,
    })
    this.name = "DesktopSendUnresolvedError"
  }
}

/** The helper shows the refusal reason; the launcher accepts at most this many characters. */
const REFUSAL_MESSAGE_MAX = 500
/** Below the helper's 20 s wait, so an approval can still reach it. */
export const RECHECK_BUDGET_MS = 15_000
const POLL_INTERVAL_MS = 2_000
/** Time that must remain when an approval is posted, so at least one status read follows it. */
const APPROVAL_MIN_WATCH_MS = 2 * POLL_INTERVAL_MS
const DEFAULT_TIMEOUT_MS = 5 * 60_000

export function getDesktopL1Bridge(): DesktopL1Bridge | null {
  const raw = (globalThis as { __ZKMONEY_DESKTOP_BRIDGE__?: unknown }).__ZKMONEY_DESKTOP_BRIDGE__
  if (!raw || typeof raw !== "object") return null
  const { l1SubmitPath, settingsPath, capabilities } = raw as Record<string, unknown>
  if (typeof l1SubmitPath !== "string" || !l1SubmitPath.startsWith("/")) return null
  return {
    l1SubmitPath,
    ...(typeof settingsPath === "string" && settingsPath.startsWith("/") ? { settingsPath } : {}),
    capabilities: Array.isArray(capabilities)
      ? capabilities.filter((c): c is string => typeof c === "string")
      : [],
  }
}

/** Where the desktop launcher's settings page is, or null off the desktop. */
export function getDesktopSettingsPath(): string | null {
  return getDesktopL1Bridge()?.settingsPath ?? null
}

/** True when the desktop bridge is the only L1 signing route (no injected wallet). */
export function isDesktopL1SubmitActive(): boolean {
  return getDesktopL1Bridge() !== null && typeof window.ethereum === "undefined"
}

export interface DesktopL1SubmitParams {
  tx: { to: Hex; data: Hex; value?: Hex; chainId: number }
  /** Human-readable summary rendered on the helper page (labels and values). */
  display: { title: string; lines: [string, string][] }
  /** Called with the helper page's URL once it has been opened — shown to the
   *  user both as orientation and as the manual fallback if no page appeared. */
  onHelperOpened?: (submitUrl: string) => void
  timeoutMs?: number
  /**
   * Runs each time the helper asks to send, right before it opens the user's wallet. Resolving
   * approves that send; rejecting, or not settling within 15 s (`DesktopRecheckTimeoutError`),
   * refuses it. The helper sends only after an approval, so until one is given every rejection of
   * `submitViaDesktopBridge` means nothing was sent. After one, every rejection is
   * `DesktopSendUnresolvedError`, including a later refusal, which rejects at once; the launcher
   * still records a hash the earlier prompt reports. Requires the launcher's `recheck` capability.
   */
  recheck?: () => Promise<void>
  /**
   * Runs once `recheck` passed in time, inside the same budget, so a caller can durably record that
   * a send may follow; the approval is posted only after it resolves. It gets the submission id, the
   * same for every approval of this transfer. Rejecting refuses that send. It can still finish after
   * the budget or the clock refused the send; if this call then rejects with anything but
   * `DesktopSendUnresolvedError`, nothing was approved and the caller may drop what it recorded.
   */
  beforeApprove?: (submission: string) => Promise<void>
}

/**
 * Hand the prepared transaction to the launcher (which opens the helper page)
 * and wait for the reported tx hash. A timeout here does NOT strand funds: an
 * approval that lands after we stop polling is still an ordinary transfer to
 * the deposit address, which SIPA discovery credits on a later sync.
 */
export async function submitViaDesktopBridge(params: DesktopL1SubmitParams): Promise<Hex> {
  const bridge = getDesktopL1Bridge()
  if (!bridge) throw new Error("Desktop L1 bridge is not available")
  // An older launcher would ignore `recheck` and let the helper send unchecked.
  if (params.recheck && !bridge.capabilities.includes("recheck")) {
    throw new DesktopBridgeUpdateRequiredError()
  }

  const createResponse = await fetch(bridge.l1SubmitPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tx: params.tx,
      display: params.display,
      ...(params.recheck ? { recheck: true } : {}),
    }),
  })
  if (createResponse.status === 409) throw new DesktopSendOpenError()
  if (!createResponse.ok) {
    throw new Error(`Desktop bridge refused the transaction: ${await createResponse.text()}`)
  }
  const { id, submitUrl } = (await createResponse.json()) as { id: string; submitUrl?: string }
  if (submitUrl) params.onHelperOpened?.(submitUrl)

  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let answered = 0
  // Set before an approval is posted: from then on its wallet prompt may send whatever ends this wait.
  let approved = false
  const poll = async (): Promise<Hex> => {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      if (Date.now() >= deadline) break
      const status = await byDeadline(deadline, async (signal) => {
        const response = await fetch(`${bridge.l1SubmitPath}/${id}`, { signal })
        if (!response.ok) throw new Error("The transaction request expired — try again")
        return (await response.json()) as SubmissionStatus
      })
      if (status === LATE) break
      if (status.state === "submitted" && status.txHash) return status.txHash
      if (
        params.recheck &&
        status.state === "checking" &&
        status.check &&
        status.check > answered
      ) {
        // Too late to approve and still watch: left unanswered, the helper fails closed.
        if (deadline - Date.now() <= APPROVAL_MIN_WATCH_MS) continue
        answered = status.check
        const answer = await answerCheck(
          `${bridge.l1SubmitPath}/${id}/recheck`,
          status.check,
          params.recheck,
          deadline,
          async () => params.beforeApprove?.(id),
          () => (approved = true),
        )
        if (!answer.ok) throw answer.error
        continue
      }
      if (status.state === "refused") {
        throw new Error(status.message ?? "This transaction request was stopped — try again")
      }
      if (status.state === "superseded") {
        throw new Error("This transaction request was replaced by a newer one")
      }
      if (status.state === "error") {
        throw new Error(status.message ?? "The browser page reported an error")
      }
    }
    throw new Error(
      "Timed out waiting for the transaction from your browser. If you have already approved it, the deposit will still be detected automatically and will appear in your wallet.",
    )
  }
  try {
    return await poll()
  } catch (error) {
    throw approved ? new DesktopSendUnresolvedError(error) : error
  }
}

const LATE = Symbol("late")

/** Runs `work`, giving up with `LATE` at `deadline` and aborting its signal. */
async function byDeadline<T>(
  deadline: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T | typeof LATE> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(LATE)
    }, Math.max(0, deadline - Date.now()))
  })
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), late])
  } finally {
    clearTimeout(timer)
  }
}

type CheckAnswer = { ok: true } | { ok: false; error: unknown }

/**
 * Answers one helper check. `record` runs after `recheck` within the same budget, and only while
 * `APPROVAL_MIN_WATCH_MS` is left. That time must still be left when the approval is posted, checked
 * then rather than trusted to the budget timer, which a hidden tab can delay; otherwise the send is
 * refused. A refusal is posted so the helper stops too.
 */
async function answerCheck(
  url: string,
  check: number,
  recheck: () => Promise<void>,
  deadline: number,
  record: () => Promise<void>,
  onApprove: () => void,
): Promise<CheckAnswer> {
  const post = (body: object) =>
    byDeadline(deadline, (signal) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ check, ...body }),
        signal,
      }),
    ).catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<CheckAnswer>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: new DesktopRecheckTimeoutError() }),
      Math.min(RECHECK_BUDGET_MS, deadline - Date.now() - APPROVAL_MIN_WATCH_MS),
    )
  })
  let answered = false
  const answer = await Promise.race([
    Promise.resolve()
      .then(recheck)
      .then(() => {
        // Never recorded for a late answer.
        if (answered || deadline - Date.now() < APPROVAL_MIN_WATCH_MS) {
          throw new DesktopRecheckTimeoutError()
        }
        return record()
      })
      .then(
        (): CheckAnswer => ({ ok: true }),
        (error: unknown): CheckAnswer => ({ ok: false, error }),
      ),
    budget,
  ])
  answered = true
  clearTimeout(timer)
  const outcome: CheckAnswer =
    answer.ok && deadline - Date.now() < APPROVAL_MIN_WATCH_MS
      ? { ok: false, error: new DesktopRecheckTimeoutError() }
      : answer
  if (!outcome.ok) {
    const { error } = outcome
    const message = error instanceof Error && error.message ? error.message : "Check failed"
    await post({ ok: false, message: message.slice(0, REFUSAL_MESSAGE_MAX) })
    return outcome
  }
  onApprove()
  await post({ ok: true })
  return outcome
}
