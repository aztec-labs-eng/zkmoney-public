import { createPace } from "@obsidion/core/cadence"
import { memoryBackend, memoryStore, openDatabase, queries } from "@obsidion/front-core"

/** A page's query factory over its own timers, always visible; its clock follows faked time. */
export const testQuery = () =>
  queries({ pace: createPace(), visible: memoryStore(true).readonly, now: () => Date.now() })

/** A page read that answers `value`. */
export const answered = <T>(value: T) =>
  testQuery()<[], T>("answered", { load: async () => value })()

/** A page chain's deps: the test query factory and a database of its own. */
export const testChain = () => ({
  query: testQuery(),
  database: openDatabase(memoryBackend()),
  now: () => Date.now(),
})
