import { useEffect, useState } from "react"
import type { AztecNode } from "@aztec/aztec.js/node"
import { pauseWhenHidden } from "../../platform/visibilityScheduler"

/**
 * Chain timestamps move per block, not per wall-clock second — poll the tip so time gates stay
 * honest, but no faster than the thing being read can change.
 *
 * At one second this probe is 44% of every node call an idle wallet makes, for 7% of its bytes.
 * What it feeds is a boundary crossing — a row offering Cancel until a paylink's window shuts, then
 * Reclaim — so the cost of reading late is a control that changes label a few seconds after it
 * could have. Five seconds is well inside a block on any network the wallet runs against.
 */
export const CHAIN_POLL_MS = 5000

/**
 * Unix seconds at the L2 tip. Paylink `from_claimable` / `until_claimable` are chain timestamps;
 * the sandbox clock and `Date.now()` routinely diverge (no ticker, per-block slot warp), so UI
 * gates must not use the wall clock.
 */
export async function latestChainSeconds(node: AztecNode): Promise<number> {
  const header = (await node.getBlockData("latest"))?.header
  if (!header) throw new Error("no L2 block — is the node running?")
  return Number(header.globalVariables.timestamp)
}

type Subscriber = (seconds: number) => void

interface Clock {
  subscribers: Set<Subscriber>
  timer: unknown | null
  /** Block the cached `seconds` was read from; `null` until the first header lands. */
  block: number | null
  seconds: number | undefined
  reading: boolean
}

/**
 * One clock per node, so N mounted surfaces cost one poll rather than N. Keyed weakly: switching
 * network builds a new client, and its clock replaces this one rather than accumulating beside it.
 */
const clocks = new WeakMap<AztecNode, Clock>()

/**
 * Advance a clock: a block number is ~26x smaller on the wire than block data, so the tip is what
 * gets polled and the header is fetched only when it moves. Nothing is held across a change, so a
 * fast chain (several blocks per checkpoint) is reported as promptly as a slow one.
 */
async function readTip(node: AztecNode, clock: Clock): Promise<void> {
  // A node slower than the tick must not accumulate overlapping reads.
  if (clock.reading) return
  clock.reading = true
  try {
    if (Number(await node.getBlockNumber()) === clock.block) return
    const header = (await node.getBlockData("latest"))?.header
    if (!header) return
    // The header's own number, not the one probed above: a block landing between the two reads
    // would otherwise leave the clock claiming a tip it never read.
    clock.block = Number(header.globalVariables.blockNumber)
    clock.seconds = Number(header.globalVariables.timestamp)
    for (const notify of clock.subscribers) notify(clock.seconds)
  } catch {
    // Transient; the next tick retries.
  } finally {
    clock.reading = false
  }
}

function subscribeToChainSeconds(node: AztecNode, notify: Subscriber): () => void {
  const clock: Clock = clocks.get(node) ?? {
    subscribers: new Set(),
    timer: null,
    block: null,
    seconds: undefined,
    reading: false,
  }
  clocks.set(node, clock)

  const live = clock.timer !== null
  clock.subscribers.add(notify)
  // Only hand over the cached value when another subscriber has been keeping it current. A clock
  // that has been idle may hold any age, and callers withhold time-gated actions on `undefined`
  // rather than acting on a timestamp that could be arbitrarily stale.
  if (live && clock.seconds !== undefined) notify(clock.seconds)
  if (!live) {
    // Start cold: a surface mounting onto a clock nobody kept running has nothing to render, and
    // the tip probe alone would report no change and tell it nothing. Forgetting the block makes
    // the first read fetch the header, so the value arrives without waiting for the chain to move.
    clock.block = null
    void readTip(node, clock)
    // Paused while the tab is hidden: the value's only consumer is a label on screen, and the
    // scheduler reads once on return so nothing renders against a stale tip.
    clock.timer = pauseWhenHidden.setInterval(() => void readTip(node, clock), CHAIN_POLL_MS)
  }

  return () => {
    clock.subscribers.delete(notify)
    if (clock.subscribers.size === 0 && clock.timer !== null) {
      pauseWhenHidden.clearInterval(clock.timer)
      clock.timer = null
    }
  }
}

/**
 * Polled chain seconds for a mounted surface. `undefined` until the first read lands (and while
 * `node` is absent) — callers withhold time-gated actions rather than falling back to `Date.now()`.
 */
export function usePolledChainSeconds(node: AztecNode | undefined): number | undefined {
  const [chainNow, setChainNow] = useState<number>()
  useEffect(() => {
    if (!node) return
    return subscribeToChainSeconds(node, setChainNow)
  }, [node])
  return chainNow
}
