/**
 * An in-memory `eth_getLogs`: what a node answers for a filter over the logs it holds, so a test
 * runs a real viem client and its filters are encoded and decoded as on L1.
 * `memoryLogs.sandbox.test.ts` runs the cases in `memoryLogsCases.ts` against it and a real node.
 */
import { createPublicClient, custom, numberToHex, type Address, type Hex } from "viem"

export interface HeldLog {
  address: Address
  topics: Hex[]
  data: Hex
  blockNumber: bigint
  transactionHash: Hex
}

export type TopicFilter = Hex | Hex[] | null

export interface LogFilter {
  address: Hex
  topics?: TopicFilter[]
  fromBlock: Hex
  toBlock: Hex
}

const topicMatches = (filter: TopicFilter, topic: Hex | undefined) =>
  filter === null ||
  (topic !== undefined && [filter].flat().some((t) => t.toLowerCase() === topic.toLowerCase()))

/** The RPC answer to `eth_getLogs(filter)` over `logs`, which are in chain order. */
export function getLogs(logs: readonly HeldLog[], filter: LogFilter) {
  const from = BigInt(filter.fromBlock)
  const to = BigInt(filter.toBlock)
  // A log's index is its place in its block, whatever the filter keeps.
  const placed = logs.map((log, i) => ({
    log,
    logIndex: logs.slice(0, i).filter((held) => held.blockNumber === log.blockNumber).length,
  }))
  return placed
    .filter(
      ({ log }) =>
        log.address.toLowerCase() === filter.address.toLowerCase() &&
        log.blockNumber >= from &&
        log.blockNumber <= to &&
        (filter.topics ?? []).every((topic, i) => topicMatches(topic, log.topics[i])),
    )
    .map(({ log, logIndex }) => ({
      ...log,
      blockNumber: numberToHex(log.blockNumber),
      logIndex: numberToHex(logIndex),
      blockHash: `0x${"bb".repeat(32)}` as Hex,
      transactionIndex: "0x0",
      removed: false,
    }))
}

/** A viem client whose node holds `logs`; `other` answers every other method. */
export function memoryLogsClient(
  logs: readonly HeldLog[],
  other: (method: string, params: unknown) => unknown = (method) => {
    throw new Error(`unexpected ${method}`)
  },
) {
  return createPublicClient({
    transport: custom(
      {
        request: async ({ method, params }: { method: string; params?: unknown }) =>
          method === "eth_getLogs"
            ? getLogs(logs, (params as [LogFilter])[0])
            : other(method, params),
      },
      { retryCount: 0 },
    ),
  })
}
