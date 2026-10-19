/** A bounded wait that ran out. The work behind it may still finish: nothing is cancelled. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`)
    this.name = "TimeoutError"
  }
}

/** Bound a promise that a screen waits on, so a stalled PXE read cannot pin the page. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new TimeoutError(ms)), ms)
    p.then(resolve, reject).finally(() => clearTimeout(id))
  })
}

/**
 * One bounded wait over several steps: a step still pending once `ms` has passed rejects with
 * `expired()`, so the flow ends at the step that stalled. `clear` once the bounded part is over.
 */
export function deadline(ms: number, expired: () => Error) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const passed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(expired()), ms)
  })
  passed.catch(() => {})
  return {
    within: <T>(step: Promise<T>): Promise<T> => Promise.race([step, passed]),
    clear: () => clearTimeout(timer),
  }
}
