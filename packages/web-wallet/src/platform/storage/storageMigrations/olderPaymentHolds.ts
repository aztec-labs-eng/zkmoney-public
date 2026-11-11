/**
 * Storage migration: the request payment holds older builds kept in `localStorage`, carried into
 * device state once. Remove when no supported build keeps them in `localStorage`.
 */
/** The holds older builds kept in `localStorage` under `key`. */
export function olderPayments(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * The saved holds with older builds' added, those saved winning; undefined when the saved ones do
 * not parse, so neither copy is touched. Older holds that do not parse add nothing.
 */
export function withOlder(saved: string | null, older: string): string | null | undefined {
  let into: Record<string, unknown>
  try {
    into = saved === null ? {} : (JSON.parse(saved) as Record<string, unknown>)
  } catch {
    return undefined
  }
  const merged = { ...entries(older), ...into }
  return Object.keys(merged).length === Object.keys(into).length ? saved : JSON.stringify(merged)
}

function entries(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? { ...parsed } : {}
  } catch {
    return {}
  }
}

export function dropOlderPayments(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch (err) {
    console.warn("[device] the older payment holds stay until the next load", err)
  }
}
