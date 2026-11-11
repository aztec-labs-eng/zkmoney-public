/**
 * The page's pace. An e2e build (`VITE_E2E_WALLET_HOOK`) takes it from the test world that may own
 * the chains: the world sets these globals before boot (`e2e/support/test.ts`), and then every poll
 * waits for its `__obsidionWakePolls` and a viem receipt wait polls at its interval. Any other
 * build, or an e2e page with no world, keeps a live network's timers.
 */
import { createPace, type Pace } from "@obsidion/core/cadence"

type WorldGlobals = {
  __OBSIDION_POLL_MAX_MS?: number
  __OBSIDION_POLLS_SIGNALLED?: boolean
  __OBSIDION_FOREIGN_POLL_MS?: number
  __OBSIDION_POLLS_TRACE?: boolean
  __obsidionWakePolls?: () => void
  __obsidionWaitingPolls?: () => string[]
}

export const pagePace = (): Pace =>
  import.meta.env.VITE_E2E_WALLET_HOOK === "true" ? worldPace() : createPace()

function worldPace(): Pace {
  const world = globalThis as WorldGlobals
  const pace = createPace({
    maxMs: world.__OBSIDION_POLL_MAX_MS,
    signalled: world.__OBSIDION_POLLS_SIGNALLED,
    foreignMaxMs: world.__OBSIDION_FOREIGN_POLL_MS,
    trace: world.__OBSIDION_POLLS_TRACE,
  })
  world.__obsidionWakePolls = pace.wake
  world.__obsidionWaitingPolls = pace.waiting
  return pace
}
