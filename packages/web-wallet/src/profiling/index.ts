/**
 * Profiling orchestrator.
 *
 * Instruments the wallet, PXE, node client, fetch and bb.js WASM from the outside — no changes to
 * front-core or sdk are needed for a span to appear.
 *
 * Parent attribution comes from async-context propagation via zone.js (see `context.ts`). Every
 * span carries an explicit `parentId` taken from the real causal chain, so concurrent async
 * operations are never mistaken for nested ones — no timing heuristics.
 *
 * Usage:
 *   await profiler.install()            // global interceptors
 *   profiler.instrumentWallet(wallet)   // wrap the wallet + its PXE, node and stores
 *   profiler.start("send")
 *   // ... perform the operation ...
 *   const report = profiler.stop()
 */

import { appVersion } from "../lib/analytics"
import { getConfig } from "../config/env"
import {
  installFetchInterceptor,
  installWasmInterceptor,
  installSimulatorInterceptorFromPXE,
  installTeeInterceptor,
} from "./interceptors"
import { currentSpan, runInSpan, zoneAvailable, bindCurrentZone, type SpanContext } from "./context"
import type { Category, ProfileEnv, ProfileRecord, ProfileReport } from "./types"

export type { Category, ProfileRecord, ProfileReport, ProfileEnv } from "./types"

// ─── Method wrapping ─────────────────────────────────────────────────────────

// Methods to skip — internal plumbing, getters, or things that break if wrapped.
const SKIP = new Set([
  // JS fundamentals
  "constructor",
  "toString",
  "toJSON",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "then", // wrapping 'then' would break Promise detection
  "catch",
  "finally",
  // Logging
  "log",
  "warn",
  "error",
  "debug",
  "info",
  "verbose",
  "trace",
  // Lifecycle (usually called during init, not during a profiled operation)
  "dispose",
  "destroy",
  // Event emitter
  "on",
  "off",
  "once",
  "emit",
  "addListener",
  "removeListener",
  "addEventListener",
  "removeEventListener",
])

/** Collect method names from an object and its prototype chain, stopping at Object.prototype. */
function collectMethods(target: any): string[] {
  const seen = new Set<string>()
  let obj = target
  while (obj && obj !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(obj)) {
      if (SKIP.has(name) || name.startsWith("_")) continue
      try {
        if (typeof obj[name] === "function" && !seen.has(name)) {
          seen.add(name)
        }
      } catch {
        // getter that throws — skip
      }
    }
    obj = Object.getPrototypeOf(obj)
  }
  return [...seen]
}

/**
 * Whether a write to `target` is observable through a subsequent read.
 *
 * A Proxy whose `get` trap synthesizes methods forwards writes to the object underneath while
 * reads keep answering from the trap — PXE's caching node wrapper (`withCache`) is one, handing
 * back either a closure from its `cachedReads` table or a per-read `value.bind(target)`. Patching
 * methods on such an object installs the wrapper *below* the trap, and the trap's closure then
 * calls straight back into it: unbounded recursion, surfacing as "Maximum call stack size
 * exceeded" on the first node read.
 *
 * The hazard is write-opacity, not read-instability (the trap's `cachedReads` closures are
 * identical on every read — the dangerous methods look stable), so probe it directly: write a
 * function under a synthetic key and see whether it reads back untouched. Any get trap that
 * mediates function reads (bind, memoized or not) fails the probe. If we cannot observe our own
 * writes we do not own the methods, so we leave them alone. A frozen object fails too, which is
 * equally correct: it cannot be patched either way.
 */
function canObserveOwnWrites(target: any): boolean {
  const key = "__profilerProbe"
  const probe = () => {}
  try {
    target[key] = probe
    const observed = target[key] === probe
    delete target[key]
    return observed
  } catch {
    return false
  }
}

/**
 * Span-wrap a staged-execution finalizer travelling inside an options bag.
 *
 * `wallet.sendTx(payload, opts)` takes `opts.finalize`, and the whole TEE payload cost lives in
 * there: the L1→L2 membership-witness reads per spent deposit, the spend-metadata resolution per
 * nullified note, the token-operation build, and only then the enclave call. Wrapping it as it
 * passes through gives that phase one parent span, so the gathering reads and the `tee` sign land
 * as its children and `finalize − signTokenOperation` is the assembly cost.
 *
 * Restricted to a plain object literal: spreading a class instance would drop its prototype, and
 * an options bag is the only shape that carries this hook.
 */
function wrapStagedFinalizer(arg: any, profiler: Profiler): any {
  if (!arg || typeof arg !== "object" || typeof arg.finalize !== "function") return arg
  if (Object.getPrototypeOf(arg) !== Object.prototype) return arg
  if (arg.finalize.__profiled) return arg
  const original = arg.finalize
  const finalize: any = (...a: any[]) => profiler.runSpan("finalize", "tee", () => original(...a))
  finalize.__profiled = true
  return { ...arg, finalize }
}

/**
 * Zone-bind callback arguments so custom queues and schedulers that call them later keep the async
 * context (zone.js covers Promise/setTimeout/addEventListener natively; user-space callback
 * patterns like SerialQueue.put need this), and span-wrap a staged finalizer in passing.
 */
function prepareArgs(args: any[], profiler: Profiler): any[] {
  return args.map((a) => {
    if (typeof a === "function" && !(a as any).__zoneBound) return bindCurrentZone(a)
    return wrapStagedFinalizer(a, profiler)
  })
}

function wrapAllMethods(target: any, category: Category, profiler: Profiler): () => void {
  const restores: (() => void)[] = []
  const methods = collectMethods(target)
  const wrappedNames: string[] = []

  if (!canObserveOwnWrites(target)) {
    console.info(
      `[profiler] skipped ${category}: writes not observable through reads, not safe to wrap in place`,
    )
    return () => {}
  }

  for (const name of methods) {
    const original = target[name]
    if (typeof original !== "function" || (original as any).__profiled) continue

    const wrapped = function (this: any, ...args: any[]) {
      if (!profiler.isRecording) return original.apply(this, args)
      return profiler.runSpan(name, category, () =>
        original.apply(this, prepareArgs(args, profiler)),
      )
    }
    ;(wrapped as any).__profiled = true
    try {
      target[name] = wrapped
      wrappedNames.push(name)
      restores.push(() => {
        target[name] = original
      })
    } catch (e) {
      console.warn(`[profiler] Could not wrap ${category}.${name}:`, e)
    }
  }

  console.info(
    `[profiler] wrapped ${category} (${wrappedNames.length} methods):`,
    wrappedNames.slice(0, 10).join(", ") + (wrappedNames.length > 10 ? ", ..." : ""),
  )
  return () => restores.forEach((r) => r())
}

/**
 * One facade per underlying object, so every property holding the same proxy (pxe.node,
 * contractSyncService.node, synchronizer.node, …) is swapped for the same facade and spans are not
 * attributed to clones.
 */
const facades = new WeakMap<object, any>()

/**
 * A profiling layer *in front of* `target`, for objects whose methods cannot be patched in place
 * (see {@link canObserveOwnWrites}). Rather than writing through the foreign trap, callers'
 * references are repointed at this facade (`root[key] = facade`), so every read lands here first
 * and is wrapped on the way out. Nothing on `target` is mutated, so its own trap logic — e.g.
 * `withCache`'s hash-pinned read cache — keeps working, and cache-served reads show up as
 * near-zero-duration spans, which in-place wrapping of the raw node underneath cannot see.
 */
function profilingFacade(target: any, category: Category, profiler: Profiler): any {
  const existing = facades.get(target)
  if (existing) return existing
  const facade = new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver)
      if (
        typeof value !== "function" ||
        typeof prop !== "string" ||
        SKIP.has(prop) ||
        prop.startsWith("_")
      ) {
        return value
      }
      const name = prop
      return function (this: any, ...args: any[]) {
        if (!profiler.isRecording) return value.apply(t, args)
        return profiler.runSpan(name, category, () => value.apply(t, prepareArgs(args, profiler)))
      }
    },
  })
  facades.set(target, facade)
  return facade
}

/**
 * Detect queue-like objects whose `get`/`put`/`process` are worker-loop infrastructure rather than
 * application operations. Their blocking `get()` can span seconds of idle time and swamp the
 * profile.
 */
function isQueueLike(obj: any): boolean {
  try {
    return typeof obj.get === "function" && typeof obj.put === "function"
  } catch {
    return false
  }
}

/** Best-effort build/tier attribution stamped into every report. Pre-boot reads throw; "" then. */
function captureEnv(): ProfileEnv {
  let network = ""
  let nodeUrl = ""
  let proverEnabled = false
  try {
    const config = getConfig()
    network = config.network
    nodeUrl = config.nodeUrl
    proverEnabled = config.proverEnabled
  } catch {
    // getConfig() throws until resolveBootConfig has seeded it.
  }
  return {
    network,
    nodeUrl,
    appVersion,
    origin: window.location.origin,
    userAgent: navigator.userAgent,
    zoneTracking: zoneAvailable(),
    proverEnabled,
    hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
  }
}

// ─── Profiler ────────────────────────────────────────────────────────────────

class Profiler {
  private _recording = false
  private _origin = 0
  private _startedAt = 0
  private _name = ""
  private _records: ProfileRecord[] = []
  private _cleanups: (() => void)[] = []
  private _installed = false
  private _installPromise: Promise<void> | undefined
  private _instrumentedWallets = new WeakSet<object>()
  /**
   * Generation counter — incremented on each start() so leaked zones from a previous recording
   * cannot pollute the current one, and spans that started during the current recording can still
   * finalize after stop().
   */
  private _generation = 0

  get isRecording() {
    return this._recording
  }
  get isInstalled() {
    return this._installed
  }

  /**
   * Push a completed record. Called by the interceptors and method wrappers. Records from the
   * given generation are accepted even after stop(), so a span whose promise resolves late still
   * gets its duration recorded.
   */
  record(
    generation: number,
    id: string,
    parentId: string | null,
    name: string,
    category: Category,
    startAbsolute: number,
    duration: number,
    detail?: string,
    error?: boolean,
  ) {
    if (generation !== this._generation) return
    this._records.push({
      id,
      parentId,
      name,
      category,
      start: startAbsolute - this._origin,
      duration,
      detail,
      error,
    })
  }

  /**
   * Run `fn` as a profiled span, inside a new zone carrying the span context so nested async
   * operations discover this span as their parent via `currentSpan()`.
   *
   * @param parentOverride - Used as the span's parent instead of whatever `currentSpan()` returns.
   *   The new zone is still forked from `Zone.current` (so downstream callbacks in it see the new
   *   span); only the recorded `parentId` changes. This is what re-parents a batched fetch out
   *   from under the node call that happened to schedule the batch's setTimeout.
   */
  runSpan<T>(
    name: string,
    category: Category,
    fn: () => T | Promise<T>,
    detail?: string,
    parentOverride?: SpanContext | null,
  ): T | Promise<T> {
    if (!this._recording) return fn()

    const generation = this._generation
    const parent = parentOverride !== undefined ? parentOverride : currentSpan()
    const span: SpanContext = {
      id: crypto.randomUUID(),
      parentId: parent?.id ?? null,
      name,
      category,
    }
    const t0 = performance.now()

    const finalize = (error?: boolean) => {
      this.record(
        generation,
        span.id,
        span.parentId,
        name,
        category,
        t0,
        performance.now() - t0,
        detail,
        error,
      )
    }

    return runInSpan(span, () => {
      let result: T | Promise<T>
      try {
        result = fn()
      } catch (e) {
        finalize(true)
        throw e
      }
      if (result && typeof (result as any).then === "function") {
        return (result as Promise<T>).then(
          (v) => {
            finalize()
            return v
          },
          (e) => {
            finalize(true)
            throw e
          },
        )
      }
      finalize()
      return result
    })
  }

  /** Install the global interceptors (fetch, bb.js WASM, TEE signer). Idempotent. */
  async install() {
    if (this._installed) return this._installPromise
    // Set the flag BEFORE any await to prevent a concurrent double-install.
    this._installed = true
    this._installPromise = (async () => {
      this._cleanups.push(installFetchInterceptor(this))
      this._cleanups.push(await installWasmInterceptor(this))
      this._cleanups.push(await installTeeInterceptor(this))
    })()
    return this._installPromise
  }

  /**
   * Manually instrument a code block. Convenience wrapper around `runSpan`.
   * @example
   *   await profiler.span("myOperation", "wallet", async () => { ... })
   */
  span<T>(name: string, category: Category, fn: () => T | Promise<T>): T | Promise<T> {
    return this.runSpan(name, category, fn)
  }

  /**
   * Wrap an `ObsidionWallet` plus its PXE, node client and PXE-internal stores. Called once per
   * wallet; `aztecNode` is accepted alongside `node` so a wallet shape from another kit still
   * instruments.
   */
  instrumentWallet(wallet: any) {
    if (!wallet || this._instrumentedWallets.has(wallet)) return
    this._instrumentedWallets.add(wallet)

    const wrapped = new Set<any>()

    wrapped.add(wallet)
    this._cleanups.push(wrapAllMethods(wallet, "wallet", this))

    const node = wallet.node ?? wallet.aztecNode
    if (node) {
      wrapped.add(node)
      this._cleanups.push(wrapAllMethods(node, "node", this))
    }

    const pxe = wallet.pxe
    if (pxe) {
      wrapped.add(pxe)
      this._cleanups.push(wrapAllMethods(pxe, "pxe", this))

      if (pxe.simulator) wrapped.add(pxe.simulator)
      this._cleanups.push(installSimulatorInterceptorFromPXE(pxe, this))

      this.instrumentInternals(pxe, wrapped, 3)
    }
  }

  /**
   * Walk an object's properties and wrap methods on sub-objects, recursing `depth` levels to catch
   * nested objects like `jobCoordinator.kvStore`, whose `transactionAsync` needs its callback
   * argument zone-bound for context to propagate.
   *
   * Queue-like objects (BaseMemoryQueue, FifoQueue, …) are skipped: their `get`/`put`/`process` are
   * worker-loop infrastructure that blocks for seconds waiting for items.
   */
  private instrumentInternals(root: any, alreadyWrapped: Set<any>, depth = 2) {
    if (depth <= 0) return
    for (const key of Object.getOwnPropertyNames(root)) {
      if (key.startsWith("_") || key === "log") continue
      let value: any
      try {
        value = root[key]
      } catch {
        continue
      }
      if (!value || typeof value !== "object") continue

      const methods = collectMethods(value)
      if (methods.length === 0) continue

      // Queue-like: has `get`+`put`, and its blocking `get()` can span seconds of idle time.
      if (isQueueLike(value)) {
        alreadyWrapped.add(value)
        continue
      }

      // An object that cannot be patched in place (a get-trap Proxy like PXE's caching node
      // wrapper) is profiled by repointing this reference at a facade. This runs per property site
      // — several PXE services hold their own field for the same proxy and each must be repointed
      // — so it comes before the alreadyWrapped identity check.
      if (!canObserveOwnWrites(value)) {
        const facade = profilingFacade(value, "store", this)
        try {
          root[key] = facade
          this._cleanups.push(() => {
            root[key] = value
          })
          console.info(
            `[profiler] facaded store .${key}: writes not observable, wrapped by reference`,
          )
        } catch (e) {
          console.warn(`[profiler] Could not facade .${key}:`, e)
        }
        alreadyWrapped.add(value)
        continue
      }

      if (alreadyWrapped.has(value)) continue
      alreadyWrapped.add(value)
      this._cleanups.push(wrapAllMethods(value, "store", this))
      this.instrumentInternals(value, alreadyWrapped, depth - 1)
    }
  }

  start(name = "profile") {
    if (this._recording) return
    this._name = name
    this._origin = performance.now()
    this._startedAt = Date.now()
    this._records = []
    this._generation++
    this._recording = true
    console.info(
      `[profiler] Started: "${name}" — zone tracking: ${
        zoneAvailable() ? "on" : "OFF (every span will be a root)"
      }`,
    )
  }

  stop(): ProfileReport {
    if (!this._recording) {
      return { name: "", startedAt: 0, durationMs: 0, records: [], env: captureEnv() }
    }
    this._recording = false
    const durationMs = performance.now() - this._origin
    const report: ProfileReport = {
      name: this._name,
      startedAt: this._startedAt,
      durationMs,
      records: [...this._records],
      env: captureEnv(),
    }
    console.info(
      `[profiler] Stopped: "${this._name}" — ${(durationMs / 1000).toFixed(2)}s, ` +
        `${report.records.length} spans`,
    )
    return report
  }

  download(report: ProfileReport) {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    const stamp = new Date(report.startedAt).toISOString().replace(/[:.]/g, "-")
    a.download = `profile-${report.env.network || "unknown"}-${report.name}-${stamp}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  uninstall() {
    this._cleanups.forEach((c) => c())
    this._cleanups = []
    this._installed = false
  }
}

export const profiler = new Profiler()
export type { Profiler }
