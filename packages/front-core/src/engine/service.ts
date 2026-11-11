import { logger } from "../utils/logger"
import { bestEffort, WalletError } from "./errors"
import { queryKey } from "./query"
import { memoryStore, type ReadonlyStore } from "./store"

/**
 * An object with a lifetime, such as a PXE or a token service. It is built once every input is
 * ready and `when` holds. An input that changes or leaves ready aborts the build in flight and
 * disposes the value it replaces, and `close()` disposes it too.
 */

export interface Backoff {
  baseMs: number
  maxMs: number
}

export type ServiceState<T> =
  | { status: "pending" }
  | { status: "ready"; value: T }
  | { status: "failed"; error: unknown }

/** What a view may read of a service: whether it is built, never its value. */
export type ServiceStatus = "loading" | "ready" | "failed"

/** A view's selector over a service's state. */
export const serviceStatus = (state: ServiceState<unknown>): ServiceStatus =>
  state.status === "pending" ? "loading" : state.status

/** The state of a service a session does not have, such as a visitor's account: never built. */
export const NO_SERVICE: ReadonlyStore<ServiceState<never>> = memoryStore<ServiceState<never>>({
  status: "pending",
}).readonly

/** What a task builds from: a service, or any store of its state. */
export type Input<V> = ReadonlyStore<ServiceState<V>>

export type Values<From> = { [K in keyof From]: From[K] extends Input<infer V> ? V : never }

export function valueOf<T>(state: ReadonlyStore<ServiceState<T>>): T | undefined {
  const now = state.get()
  return now.status === "ready" ? now.value : undefined
}

export interface Service<T> extends ReadonlyStore<ServiceState<T>> {
  readonly name: string
  /** The value once built. Rejects when a build fails, the service closes, or `signal` aborts. */
  ready(signal?: AbortSignal): Promise<T>
  /** Builds again now, ahead of any backoff; the only retry of a "manual" service. */
  retry(): void
  /** Aborts the build in flight and disposes the value. */
  close(): void
}

export interface ServiceSpec<From, T> {
  from: From
  /** Builds only while true; false aborts the build in flight and disposes the value. */
  when?: ReadonlyStore<boolean>
  /** Releases a value the service no longer holds. A failure is logged. */
  dispose?: (value: T) => void | Promise<void>
  /** A failed build retries after `baseMs`, doubling to `maxMs`; "manual" waits for `retry()`. */
  retry: Backoff | "manual"
}

export function service<const From extends readonly Service<unknown>[], T>(
  name: string,
  spec: ServiceSpec<From, T>,
  build: (inputs: Values<From>, signal: AbortSignal) => Promise<T>,
): Service<T> {
  const state = memoryStore<ServiceState<T>>({ status: "pending" })
  let closed = false
  /** The input values of the build in flight or of the value in place. */
  let built: unknown[] | undefined
  let run: AbortController | undefined
  let failures = 0
  /** Counts builds begun, so one that a subscriber superseded while it began stops. */
  let begun = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const dispose = (value: T) => {
    if (spec.dispose) void bestEffort("unknown", Promise.resolve(value).then(spec.dispose))
  }

  const release = (next: ServiceState<T>) => {
    clearTimeout(timer)
    run?.abort()
    run = undefined
    built = undefined
    const now = state.get()
    if (now.status === "ready") dispose(now.value)
    if (now.status !== "pending" || next.status !== "pending") state.set(next)
  }

  const inputs = (): unknown[] | undefined => {
    if (spec.when && !spec.when.get()) return undefined
    const states = spec.from.map((input) => input.get())
    return states.every((s) => s.status === "ready")
      ? states.map((s) => (s as { value: unknown }).value)
      : undefined
  }

  const buildFrom = (values: unknown[]) => {
    const mine = ++begun
    // The pending state runs subscribers now, and one may close the service, turn `when` off or
    // begin a newer build.
    release({ status: "pending" })
    if (closed || mine !== begun || !inputs()) return
    const current = (run = new AbortController())
    built = values
    const { signal } = current
    new Promise<T>((resolve) => resolve(build(values as Values<From>, signal))).then(
      (value) => {
        if (signal.aborted) return dispose(value)
        failures = 0
        state.set({ status: "ready", value })
      },
      (error: unknown) => {
        if (signal.aborted) return
        logger.warn(`[service] ${name} failed:`, error)
        if (spec.retry === "manual") return state.set({ status: "failed", error })
        failures++
        const delay = Math.min(spec.retry.baseMs * 2 ** (failures - 1), spec.retry.maxMs)
        state.set({ status: "failed", error })
        timer = setTimeout(() => follow(true), delay)
      },
    )
  }

  /** Builds once every input is ready and `when` holds, unless the value in place was built from the same ones. */
  const follow = (force = false) => {
    if (closed) return
    const values = inputs()
    if (!values) return release({ status: "pending" })
    const same = built?.length === values.length && values.every((v, i) => Object.is(v, built?.[i]))
    if (force || !same) buildFrom(values)
  }

  const offs = [...spec.from, ...(spec.when ? [spec.when] : [])].map((input) =>
    input.subscribe(() => follow()),
  )
  follow()

  return {
    ...state.readonly,
    name,
    ready: (signal) => readyOf(state, name, signal),
    retry: () => follow(true),
    close() {
      if (closed) return
      closed = true
      for (const off of offs) off()
      release({ status: "failed", error: new WalletError("aborted", `${name} closed`) })
    },
  }
}

/** A service ready from the start: a page's fixed input. */
export function fixed<T>(name: string, value: T): Service<T> {
  const state = memoryStore<ServiceState<T>>({ status: "ready", value })
  const ready = (signal?: AbortSignal) => readyOf(state.readonly, name, signal)
  return { ...state.readonly, name, ready, retry() {}, close() {} }
}

/** `state`'s value once ready. Rejects when it fails or `signal` aborts. */
export function readyOf<T>(
  state: ReadonlyStore<ServiceState<T>>,
  name: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const end = (settle: () => void) => {
      done = true
      off()
      signal?.removeEventListener("abort", aborted)
      settle()
    }
    const aborted = () => end(() => reject(new WalletError("aborted", `${name} aborted`)))
    const check = () => {
      if (done) return
      const now = state.get()
      if (now.status === "ready") end(() => resolve(now.value))
      else if (now.status === "failed") end(() => reject(now.error))
    }
    const off = state.subscribe(check)
    if (signal?.aborted) return aborted()
    signal?.addEventListener("abort", aborted)
    check()
  })
}

export interface KeyedServiceSpec<A extends unknown[], From, T>
  extends Omit<ServiceSpec<From, T>, "from"> {
  /** None by default. */
  from?: From
  /** The parts of the arguments that tell two services apart, keyed as a query's are. All by default. */
  key?: (...args: A) => readonly unknown[]
}

export interface KeyedService<A extends unknown[], T> {
  (...args: A): Service<T>
  /** Closes every service it built. */
  close(): void
}

/**
 * One service per key, built on the first call for that key from the key's arguments and `from`.
 * With no arguments it is one service that exists once something asks for it. A "manual" one that
 * failed builds again on its next call.
 */
export function keyedService<
  A extends unknown[],
  T,
  const From extends readonly Service<unknown>[] = [],
>(
  name: string,
  { key = (...args) => args, from = [] as unknown as From, ...rest }: KeyedServiceSpec<A, From, T>,
  build: (args: A, inputs: Values<From>, signal: AbortSignal) => Promise<T>,
): KeyedService<A, T> {
  const spec = { ...rest, from }
  const services = new Map<string, Service<T>>()
  const at = (...args: A) => {
    const k = queryKey(key(...args))
    let entry = services.get(k)
    if (!entry) {
      const entryName = args.length ? `${name}:${k}` : name
      entry = service(entryName, spec, (inputs, signal) => build(args, inputs, signal))
      services.set(k, entry)
    } else if (spec.retry === "manual" && entry.get().status === "failed") entry.retry()
    return entry
  }
  return Object.assign(at, { close: () => services.forEach((s) => s.close()) })
}
