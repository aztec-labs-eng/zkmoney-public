import type { QueryEntry, QueryFactory, Service } from "@obsidion/front-core"

const POLL_MS = 30_000

type ProvenReader = { getCheckpointNumber: (tag: "proven") => Promise<number | bigint> }

/** Whether the network has proven a checkpoint, read every 30 s while subscribed until it holds. */
export type NetworkReady = QueryEntry<boolean>

/** The page's readiness, read off its wallet's node once the wallet is built. */
export function networkReadiness(
  query: QueryFactory,
  wallet: Pick<Service<{ node: ProvenReader }>, "ready">,
): NetworkReady {
  return query<[], boolean>("networkReady", {
    load: async (signal) =>
      BigInt(await (await wallet.ready(signal)).node.getCheckpointNumber("proven")) >= 1n,
    poll: POLL_MS,
    final: (ready) => ready,
  })()
}
