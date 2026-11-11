import type { AztecNode } from "@aztec-labs/aztec.js/node"
import {
  liveStore,
  WalletError,
  type QueryEntry,
  type QueryFactory,
  type ReadonlyStore,
  type Service,
} from "@obsidion/front-core"

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

/** The wallet node's chain seconds, polled while subscribed; undefined until a read lands. */
export type ChainClock = ReadonlyStore<number | undefined>

interface Tip {
  block: number
  seconds: number
}

/**
 * The page's clock over its wallet's node, so N mounted surfaces cost one poll rather than N. A
 * read waits for the wallet, so a view subscribes once the wallet is built.
 */
export function chainClock(
  query: QueryFactory,
  wallet: Pick<Service<{ node: AztecNode }>, "ready">,
): ChainClock {
  return subscribedSeconds(nodeTip(query, async (signal) => (await wallet.ready(signal)).node))
}

function nodeTip(
  query: QueryFactory,
  nodeOf: (signal: AbortSignal) => Promise<AztecNode>,
): QueryEntry<Tip> {
  const tip: QueryEntry<Tip> = query<[], Tip>("chainClock", {
    /**
     * A block number is ~26x smaller on the wire than block data, so the tip is what gets polled
     * and the header is fetched only when it moves.
     */
    async load(signal) {
      const node = await nodeOf(signal)
      const block = Number(await node.getBlockNumber())
      const held = tip.get()
      // A new object, so a subscriber can tell this read from a failed one that kept the value.
      if (held.status === "ready" && held.value.block === block) return { ...held.value }
      const header = (await node.getBlockData("latest"))?.header
      if (!header) throw new WalletError("unknown", "no L2 block")
      // The header's own number, not the one probed above: a block landing between the two reads
      // would otherwise leave the clock claiming a tip it never read.
      return {
        block: Number(header.globalVariables.blockNumber),
        seconds: Number(header.globalVariables.timestamp),
      }
    },
    poll: CHAIN_POLL_MS,
    // A subscriber after a gap reads at once.
    stale: CHAIN_POLL_MS,
  })()
  return tip
}

/**
 * The tip's seconds once a read lands for the current subscribers. An idle clock may hold any age,
 * and callers withhold time-gated actions on `undefined` rather than acting on it.
 */
function subscribedSeconds(tip: QueryEntry<Tip>): ReadonlyStore<number | undefined> {
  return liveStore<number | undefined>(undefined, {
    whileSubscribed(set) {
      /** The value held when this subscription's first read began: a failed read keeps it. */
      let held: Tip | undefined
      let landed = false
      const show = () => {
        const s = tip.get()
        if (s.status === "ready" && s.refreshing && !landed) held = s.value
        if (s.status === "ready" && !s.refreshing && s.value !== held) landed = true
        // A failed read again withholds the kept tip, as a failed first read does.
        set(landed && s.status === "ready" && s.error === undefined ? s.value.seconds : undefined)
      }
      const off = tip.subscribe(show)
      show()
      return () => {
        off()
        set(undefined)
      }
    },
  })
}
