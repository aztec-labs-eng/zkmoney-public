/**
 * The one place the wallet decides what a background tab costs.
 *
 * Every repeating read the wallet makes is a poll nobody is reading while the tab is hidden, and
 * the node bills for it either way. Rather than teach each loop about `document`, loops take an
 * interval scheduler; these are the two the browser front supplies. Front-core services accept the
 * same shape, so a service stays platform-neutral.
 *
 * Every policy runs a catch-up tick the moment the page is shown, so what a returning user reads is
 * current before they read it rather than up to one interval stale.
 */

/** The interval surface front-core services and the wallet's own loops take. */
export interface IntervalScheduler {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

interface Entry {
  callback: () => void
  ms: number
  /** Multiplier applied while hidden; `Infinity` stops the timer instead. */
  hiddenFactor: number
  handle: ReturnType<typeof setInterval> | null
}

const entries = new Set<Entry>()
let listening = false

const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden"

function reschedule(entry: Entry): void {
  if (entry.handle !== null) {
    clearInterval(entry.handle)
    entry.handle = null
  }
  const hidden = isHidden()
  if (hidden && entry.hiddenFactor === Infinity) return
  entry.handle = setInterval(entry.callback, hidden ? entry.ms * entry.hiddenFactor : entry.ms)
}

function onVisibilityChange(): void {
  const showing = !isHidden()
  for (const entry of entries) {
    if (showing) entry.callback()
    reschedule(entry)
  }
}

function listen(): void {
  if (listening || typeof document === "undefined") return
  document.addEventListener("visibilitychange", onVisibilityChange)
  listening = true
}

function scheduler(hiddenFactor: number): IntervalScheduler {
  return {
    setInterval(callback, ms) {
      listen()
      const entry: Entry = { callback, ms, hiddenFactor, handle: null }
      entries.add(entry)
      reschedule(entry)
      return entry
    },
    clearInterval(handle) {
      const entry = handle as Entry | null
      if (!entry || !entries.delete(entry)) return
      if (entry.handle !== null) clearInterval(entry.handle)
      entry.handle = null
    },
  }
}

/**
 * Stops while the page is hidden. For work whose only consumer is the screen — a clock behind a
 * label, a check whose result is a notification the user reads on return.
 */
export const pauseWhenHidden: IntervalScheduler = scheduler(Infinity)

/**
 * Keeps running at `ms * factor` while hidden. For work that must keep advancing with nobody
 * watching, such as money already in flight, where stopping would strand it until the user returns.
 */
export function slowWhenHidden(factor: number): IntervalScheduler {
  return scheduler(factor)
}

/**
 * For a loop that owns its own start/stop rather than an interval — a service told to run, a
 * watcher that re-reads on return. Both handlers see the current state immediately, so a caller
 * does not also have to ask.
 */
export function whenVisibilityChanges(handlers: {
  onShow?: () => void
  onHide?: () => void
}): () => void {
  const fire = () => (isHidden() ? handlers.onHide?.() : handlers.onShow?.())
  fire()
  if (typeof document === "undefined") return () => {}
  document.addEventListener("visibilitychange", fire)
  return () => document.removeEventListener("visibilitychange", fire)
}
