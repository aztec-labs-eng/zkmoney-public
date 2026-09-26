/**
 * Async-context tracking via zone.js.
 *
 * When a profiled method runs, it forks a child zone tagged with its span ID.
 * Zone.js monkey-patches Promise, setTimeout, fetch, setInterval, and other async APIs to
 * propagate the zone across await boundaries and callbacks.
 *
 * Zone.js is loaded at app entry only in a profiling build (see `boot.tsx`). When it is not
 * loaded, `Zone` is undefined and every function here degrades to a no-op — the profiler falls
 * back to parentless spans and the waterfall renders flat.
 */

import type { Category } from "./types"

export interface SpanContext {
  id: string
  parentId: string | null
  name: string
  category: Category
}

const SPAN_KEY = "profiler:span"

/** Access zone.js through globalThis so bundlers don't tree-shake it away. */
function getZone(): any {
  return (globalThis as any).Zone
}

/** True when zone.js has been loaded (async-context tracking active). */
export function zoneAvailable(): boolean {
  const Zone = getZone()
  return !!Zone && !!Zone.current
}

/** Read the span context attached to the current zone (or ancestors). */
export function currentSpan(): SpanContext | undefined {
  const Zone = getZone()
  if (!Zone || !Zone.current) return undefined
  return Zone.current.get(SPAN_KEY)
}

/**
 * Walk up the zone chain and return the first span whose category is not in `skipCategories`.
 * Used by the fetch interceptor to skip past node-layer spans so a batched RPC fetch becomes a
 * sibling of the node calls it groups (rather than nested under whichever node call happened to
 * schedule the batch's setTimeout first).
 */
export function findAncestorSpan(skipCategories: ReadonlySet<Category>): SpanContext | undefined {
  const Zone = getZone()
  if (!Zone || !Zone.current) return undefined
  let zone = Zone.current
  while (zone) {
    const span: SpanContext | undefined = zone.get(SPAN_KEY)
    if (span && !skipCategories.has(span.category)) return span
    zone = zone.parent
  }
  return undefined
}

/**
 * Run `fn` inside a child zone carrying the given span as context. Any async operation started by
 * `fn` (or its descendants) inherits this zone and sees the span via `currentSpan()`.
 */
export function runInSpan<T>(span: SpanContext, fn: () => T): T {
  const Zone = getZone()
  if (!Zone || !Zone.current) return fn()
  const zone = Zone.current.fork({
    name: `${span.category}:${span.name}`,
    properties: { [SPAN_KEY]: span },
  })
  return zone.run(fn)
}

/**
 * Wrap a callback so that when it is later invoked (e.g. dequeued by a background worker), it runs
 * in the zone that was current at the time this wrap happened.
 *
 * Zone.js propagates context automatically through Promise.then, setTimeout, setInterval and
 * addEventListener. Custom queue patterns — the PXE's SerialQueue worker is started once at init
 * in the root zone and processes items in place — lose it. Capturing the zone at enqueue time is
 * what rescues it.
 */
export function bindCurrentZone<F extends (...args: any[]) => any>(fn: F): F {
  const Zone = getZone()
  if (!Zone || !Zone.current) return fn
  const captured = Zone.current
  const bound: any = (...args: any[]) => captured.run(() => fn(...args))
  bound.__zoneBound = true
  return bound as F
}
