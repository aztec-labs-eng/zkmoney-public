/** Tiny semaphore for capping concurrent async work.
 * Consumed by `TxLifecycleService` and `ReorgMonitor` to limit the number of concurrent `getTxReceipt` calls.
 */
export function makeLimiter(maxConcurrent: number) {
  let active = 0
  const queue: Array<() => void> = []
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => queue.push(resolve))
    }
    active++
    try {
      return await fn()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}
