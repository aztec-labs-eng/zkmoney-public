/**
 * Web Locks, which every browser the passkey policy admits has (`passkeysSupported` requires them).
 * A browser realm without `navigator.locks` is refused rather than served by a stand-in that
 * serializes nothing across tabs; a same-realm queue per name serves only the node test
 * environment, which has no window.
 */
const queues = new Map<string, Promise<unknown>>()

export class WebLocksUnavailableError extends Error {
  constructor() {
    super("Web Locks are unavailable in this browser")
    this.name = "WebLocksUnavailableError"
  }
}

export async function withWebLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as (Navigator & { locks?: LockManager }) | undefined)?.locks
  if (locks?.request) return locks.request(name, fn) as Promise<T>
  if (typeof window !== "undefined") throw new WebLocksUnavailableError()
  const previous = queues.get(name) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  queues.set(
    name,
    run.catch(() => {}),
  )
  return run
}
