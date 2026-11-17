import {
  derived,
  liveStore,
  memoryStore,
  type QueryEntry,
  type ReadonlyStore,
} from "@obsidion/front-core"
import type { PageBoot } from "../app/sessionDeps"
import { devMockRoute } from "../app/devRoutes"

/** Whether a move from pathname `from` to `to` opens another mock, which needs its own page. */
export function opensMock(from: string, to: string): boolean {
  return to !== from && devMockRoute(to, "") !== undefined
}

interface MockBoot {
  /** The pathname the boot last followed. */
  path: string
  generation: number
  boot: QueryEntry<PageBoot>
}

/** Settles once `boot` stops loading, with the page it built marked as leaving: its journeys stop. */
function leave(boot: QueryEntry<PageBoot>): Promise<void> {
  const held = boot.get()
  if (held.status === "failed") return Promise.resolve()
  if (held.status === "ready") {
    held.value.page.leaving.set(true)
    return Promise.resolve()
  }
  return Promise.allSettled([boot.read()]).then(([read]) => {
    if (read.status === "fulfilled") read.value.page.leaving.set(true)
  })
}

/**
 * The current boot, from `first`. `follow` reads the location and, when it moved onto another mock,
 * starts a `next` boot that seeds once the last one settles, so one seed writes at a time.
 */
export function mockBoots(
  first: QueryEntry<PageBoot>,
  next: (after: Promise<void>) => QueryEntry<PageBoot>,
): { current: ReadonlyStore<MockBoot>; follow(): void } {
  const state = memoryStore<MockBoot>({ path: location.pathname, generation: 0, boot: first })
  const follow = () => {
    const held = state.get()
    const to = location.pathname
    if (to === held.path) return
    if (!opensMock(held.path, to)) return state.set({ ...held, path: to })
    state.set({ path: to, generation: held.generation + 1, boot: next(leave(held.boot)) })
  }
  // Back and forward follow while the boot is read.
  const popped = liveStore(undefined, {
    whileSubscribed: () => {
      addEventListener("popstate", follow)
      return () => removeEventListener("popstate", follow)
    },
  })
  return { current: derived([state.readonly, popped], (boot) => boot), follow }
}
