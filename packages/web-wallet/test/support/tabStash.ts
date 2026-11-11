import type { tabStash } from "../../src/platform/storage/tabStash"

/** A tab stash over a map, for a test that keeps no browser storage. */
export function fakeTabStash(): typeof tabStash {
  const map = new Map<string, string>()
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  }
}
