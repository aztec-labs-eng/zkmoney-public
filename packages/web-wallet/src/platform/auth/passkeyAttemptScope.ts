import type { PasskeyRequestScope } from "@obsidion/passkey-web"

/** A status callback that also says which passkey attempt asked for the account. */
export type AttemptStatus = ((status: string) => void) & {
  readonly passkeyScope?: PasskeyRequestScope
}

/**
 * Account creation runs inside front-core, which passes the caller's status callback to
 * `createPasskey` and nothing else the screen gave it. The attempt's scope rides on that callback,
 * so the requests the creation makes — the assertion the driver chains for key material included —
 * belong to the attempt that asked for them rather than to whichever attempt is newest by then.
 * A callback that carries none leaves those requests with the newest open attempt.
 */
export function statusForAttempt(
  own: PasskeyRequestScope,
  status: (value: string) => void = () => {},
): AttemptStatus {
  return Object.assign((value: string) => status(value), { passkeyScope: own })
}

/** The attempt a status callback speaks for, if it speaks for one. */
export function scopeOfStatus(status: unknown): PasskeyRequestScope | undefined {
  return typeof status === "function" ? (status as AttemptStatus).passkeyScope : undefined
}
