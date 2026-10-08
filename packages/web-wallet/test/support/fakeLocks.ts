/**
 * Web Locks for one origin, shared by the "tabs" a test simulates: exclusive locks with
 * `ifAvailable`, `steal` and `signal`, granted in request order. A steal rejects the holder's
 * request with `AbortError` and leaves its callback running, as browsers do.
 */
type Callback = (lock: Lock | null) => unknown

interface Request {
  name: string
  callback: Callback
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const abortError = () => new DOMException("The lock request was aborted", "AbortError")

export class FakeLocks {
  private held = new Map<string, Request>()
  private queued = new Map<string, Request[]>()

  request = <T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => T),
    maybeCallback?: (lock: Lock | null) => T,
  ): Promise<Awaited<T>> =>
    new Promise<unknown>((resolve, reject) => {
      const [options, callback] =
        typeof optionsOrCallback === "function"
          ? [{} as LockOptions, optionsOrCallback]
          : [optionsOrCallback, maybeCallback!]
      const request: Request = { name, callback, resolve, reject }
      if (options.signal?.aborted) return reject(abortError())
      if (options.steal) {
        const holder = this.held.get(name)
        this.held.delete(name)
        holder?.reject(abortError())
        return this.grant(request)
      }
      if (!this.held.has(name) && !this.queue(name).length) return this.grant(request)
      if (options.ifAvailable) {
        Promise.resolve()
          .then(() => callback(null))
          .then(resolve, reject)
        return
      }
      this.queue(name).push(request)
      options.signal?.addEventListener("abort", () => {
        const queue = this.queue(name)
        const at = queue.indexOf(request)
        if (at < 0) return
        queue.splice(at, 1)
        reject(abortError())
      })
    }) as Promise<Awaited<T>>

  isHeld(name: string): boolean {
    return this.held.has(name)
  }

  private queue(name: string): Request[] {
    let queue = this.queued.get(name)
    if (!queue) this.queued.set(name, (queue = []))
    return queue
  }

  private grant(request: Request): void {
    this.held.set(request.name, request)
    Promise.resolve()
      .then(() => request.callback({ name: request.name, mode: "exclusive" } as Lock))
      .then(
        (value) => {
          this.release(request)
          request.resolve(value)
        },
        (error: unknown) => {
          this.release(request)
          request.reject(error)
        },
      )
  }

  private release(request: Request): void {
    if (this.held.get(request.name) !== request) return
    this.held.delete(request.name)
    const next = this.queue(request.name).shift()
    if (next) this.grant(next)
  }
}
