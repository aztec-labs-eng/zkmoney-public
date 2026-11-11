import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { memoryStore, serviceStatus, useStore, type ReadonlyStore } from "@obsidion/front-core"
import { useSession } from "../../session/session"

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

/** Calls `notify` with the clock's seconds once read, and with each change. */
export function subscribeToChainSeconds(
  clock: ReadonlyStore<number | undefined>,
  notify: (seconds: number) => void,
): () => void {
  const tell = () => {
    const now = clock.get()
    if (now !== undefined) notify(now)
  }
  const off = clock.subscribe(tell)
  tell()
  return off
}

const UNWATCHED = memoryStore<number | undefined>(undefined).readonly

/**
 * Polled chain seconds for a mounted surface while `on`. `undefined` until the first read lands (and
 * while the wallet is not built) — callers withhold time-gated actions rather than falling back to
 * `Date.now()`.
 */
export function usePolledChainSeconds(on = true): number | undefined {
  const { page, wallet } = useSession()
  const built = useStore(wallet, serviceStatus) === "ready"
  return useStore(on && built ? page.chainClock : UNWATCHED)
}
