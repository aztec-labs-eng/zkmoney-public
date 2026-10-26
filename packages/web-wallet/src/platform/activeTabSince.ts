/**
 * When this tab became the active one. Set once by the app from the active-tab gate; read by flows
 * that judge whether a row another page seeded can still have a live send behind it.
 */
let since: number | undefined

export function setActiveTabSince(at: number): void {
  since = at
}

/** The gate's time, or this page's start when no gate ran (the demo and the tests). */
export function activeTabSince(): number {
  return since ?? performance.timeOrigin
}
