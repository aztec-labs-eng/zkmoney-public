/** Bound a promise that a screen waits on, so a stalled PXE read cannot pin the page. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    p.then(resolve, reject).finally(() => clearTimeout(id))
  })
}
