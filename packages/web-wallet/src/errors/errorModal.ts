import { type PasskeyReportEnv, passkeyReportEnvFor } from "@obsidion/passkey-web"
import { passkeyTelemetry } from "../lib/passkeyTelemetry"

/**
 * Module-level emitter for the global error/info modal, callable from any
 * catch block without a React context. `ErrorModalHost` (mounted once at the
 * root) subscribes and renders the modal.
 */
export type ErrorModalPayload = {
  title: string
  message: string
  /** Raw technical payload, rendered smaller under the message. */
  detail?: string
  /**
   * Show Copy + Report. Off by default — known error templates own their
   * copy and don't need it. Opt in per template, or for unknown/unexpected
   * errors caught without a specific template.
   */
  showReport?: boolean
  /** Flow tag included in shared error reports, e.g. "deposit:send". */
  context?: string
  /** Device and passkey provider when the modal was raised; a report sends it. */
  env?: PasskeyReportEnv
}

let listener: ((payload: ErrorModalPayload) => void) | null = null
// Buffers errors raised before `ErrorModalHost` mounts (early boot); flushed
// on subscribe so they are not silently dropped.
let pending: ErrorModalPayload[] = []
const MAX_PENDING = 3

export function showErrorModal(raised: Omit<ErrorModalPayload, "env">): void {
  const payload = { ...raised, env: reportEnv() }
  if (listener) listener(payload)
  else if (pending.length < MAX_PENDING) pending.push(payload)
}

/** The error shows whether or not the device can be described. */
function reportEnv(): PasskeyReportEnv | undefined {
  try {
    return passkeyReportEnvFor(passkeyTelemetry.snapshot())
  } catch {
    return undefined
  }
}

/** Normalize a caught value into the reportable modal used for unexpected failures. */
export function showReportableError(
  raw: unknown,
  context: string,
  options: { title?: string; message?: string } = {},
): void {
  const error = raw instanceof Error ? raw : new Error(String(raw))
  showErrorModal({
    title: options.title ?? "Unexpected error",
    message: options.message ?? error.message,
    detail: error.stack,
    showReport: true,
    context,
  })
}

export function subscribeErrorModal(l: (payload: ErrorModalPayload) => void): () => void {
  listener = l
  for (const p of pending.splice(0)) l(p)
  return () => {
    if (listener === l) listener = null
  }
}
