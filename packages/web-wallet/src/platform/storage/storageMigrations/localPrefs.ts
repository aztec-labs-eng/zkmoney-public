/**
 * Storage migration: the preferences older builds kept in `localStorage`, carried into device state
 * by its load. Remove when no supported build keeps them in `localStorage`.
 */
import type { Write } from "@obsidion/front-core"

/**
 * Stages in `w` each of `keys` that older builds kept in `localStorage` with a value `reads`
 * accepts, and returns those values by key. A value that does not read is left where it is. The
 * `localStorage` copies stay, so a database in memory carries them again on the next page.
 */
export function carryLocalPrefs(
  w: Write,
  keys: readonly string[],
  reads: (key: string, raw: string) => boolean,
): ReadonlyMap<string, string> {
  const carried = new Map<string, string>()
  for (const key of keys) {
    const raw = olderValue(key)
    if (raw === null || !reads(key, raw)) continue
    w.put(key, raw)
    carried.set(key, raw)
  }
  return carried
}

function olderValue(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
