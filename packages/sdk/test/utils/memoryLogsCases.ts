/**
 * The filters `memoryLogs.ts` must answer as a node does. Each transaction in `txs` emits its logs
 * from one address, in its own block. Each case names the logs it returns by their index, and
 * `logIndex` the index the node gives each.
 */
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem"
import type { LogFilter } from "./memoryLogs.js"

const word = (tag: string) => keccak256(toHex(tag))

export function logCases(a: Address, b: Address) {
  const [t0, t1, x, y] = ["t0", "t1", "x", "y"].map(word) as [Hex, Hex, Hex, Hex]
  const logs = [
    { address: a, topics: [t0, x], data: word("data0") },
    { address: b, topics: [t0, x], data: word("data1") },
    { address: a, topics: [t1, y, x], data: word("data2") },
    { address: a, topics: [t0, y], data: "0x" as Hex },
    { address: a, topics: [t1], data: word("data4") },
  ]
  const txs = [[0], [1], [2], [3, 4]]
  /** `blocks[i]` is the block of `logs[i]`. */
  const span = (blocks: readonly bigint[], from = blocks[0]!, to = blocks.at(-1)!) => ({
    fromBlock: toHex(from),
    toBlock: toHex(to),
  })
  const cases: {
    name: string
    filter: (blocks: readonly bigint[]) => LogFilter
    expected: number[]
    logIndex?: number[]
  }[] = [
    {
      name: "the address, in any case",
      filter: (blocks) => ({ address: getAddress(a), ...span(blocks) }),
      expected: [0, 2, 3, 4],
    },
    {
      name: "both ends of the range",
      filter: (blocks) => ({
        address: a.toLowerCase() as Hex,
        ...span(blocks, blocks[2], blocks[3]),
      }),
      expected: [2, 3, 4],
    },
    {
      name: "nothing past the range's end",
      filter: (blocks) => ({ address: a, ...span(blocks, blocks[0], blocks[3]! - 1n) }),
      expected: [0, 2],
    },
    {
      name: "the first topic",
      filter: (blocks) => ({ address: a, topics: [t0], ...span(blocks) }),
      expected: [0, 3],
    },
    {
      name: "a wildcard, then a topic",
      filter: (blocks) => ({ address: a, topics: [null, y], ...span(blocks) }),
      expected: [2, 3],
    },
    {
      name: "any of several topics, and a topic the log lacks",
      filter: (blocks) => ({ address: a, topics: [[t0, t1], null, x], ...span(blocks) }),
      expected: [2],
    },
    {
      name: "a topic in another position",
      filter: (blocks) => ({ address: a, topics: [x], ...span(blocks) }),
      expected: [],
    },
    {
      name: "a log's index as its place in its block, not in the answer",
      filter: (blocks) => ({ address: a, topics: [t1], ...span(blocks, blocks[4], blocks[4]) }),
      expected: [4],
      logIndex: [1],
    },
  ]
  return { logs, txs, cases }
}
