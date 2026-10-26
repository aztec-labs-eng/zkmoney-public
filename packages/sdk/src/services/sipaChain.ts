/**
 * The L1 logs every tracked SIPA shares, read for any number of SIPAs per request. Each filter names
 * its SIPAs in an indexed topic: the portal's deposits by commitment, token transfers by sender or
 * recipient. See docs/bridge/sipa-pipeline.md.
 */

import type { Address, Hex, PublicClient } from "viem"
import { erc20Abi, parseEventLogs } from "viem"
import { OxidePortalEventsAbi, SIPAAbi } from "@oxide/l1-contracts"
import { chunkedContractEvents } from "./l1Logs.js"

/** Topic values per filter. */
export const SIPA_TOPICS_PER_FILTER = 500

/** A portal `Deposit`: one sweep of a SIPA whose intent routes to `recipientCommitment`. */
export interface PortalDeposit {
  recipientCommitment: Hex
  /** The amount credited on L2: the claim's `amount`. */
  amount: bigint
  /** The L1→L2 message hash. */
  key: Hex
  /** The inbox leaf index: the claim's `inbox_index`. */
  index: bigint
  blockNumber: bigint
  txHash: Hex
  logIndex: number
}

/** An ERC-20 `Transfer`. */
export interface TokenTransfer {
  token: Address
  from: Address
  to: Address
  value: bigint
  blockNumber: bigint
  txHash: Hex
  logIndex: number
}

const byPosition = (
  a: { blockNumber: bigint; logIndex: number },
  b: { blockNumber: bigint; logIndex: number },
) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += SIPA_TOPICS_PER_FILTER) {
    out.push(values.slice(i, i + SIPA_TOPICS_PER_FILTER))
  }
  return out
}

type RawLog = {
  address: Address
  args: Record<string, unknown>
  blockNumber: bigint
  transactionHash: Hex
  logIndex: number
}

/** Every portal `Deposit` to one of `commitments` in `[fromBlock, toBlock]`, in chain order. */
export async function readPortalDeposits(
  publicClient: PublicClient,
  portal: Address,
  commitments: readonly Hex[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<PortalDeposit[]> {
  const unique = [...new Set(commitments.map((c) => c.toLowerCase() as Hex))]
  const logs = await Promise.all(
    chunks(unique).map((recipientCommitment) =>
      chunkedContractEvents(
        publicClient,
        {
          address: portal,
          abi: OxidePortalEventsAbi,
          eventName: "Deposit",
          args: { recipientCommitment },
        },
        fromBlock,
        toBlock,
      ),
    ),
  )
  return (logs.flat() as RawLog[])
    .map((log) => ({
      recipientCommitment: (log.args.recipientCommitment as Hex).toLowerCase() as Hex,
      amount: log.args.amount as bigint,
      key: log.args.key as Hex,
      index: log.args.index as bigint,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
    }))
    .sort(byPosition)
}

/**
 * Every `Transfer` of `tokens` whose `side` is one of `sipas` in `[fromBlock, toBlock]`, in chain
 * order: `"from"` reads what left the SIPAs (sweeps and recoveries), `"to"` what funded them.
 */
export async function readTokenTransfers(
  publicClient: PublicClient,
  tokens: readonly Address[],
  side: "from" | "to",
  sipas: readonly Address[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TokenTransfer[]> {
  if (tokens.length === 0 || sipas.length === 0) return []
  const unique = [...new Set(sipas.map((s) => s.toLowerCase() as Address))]
  const logs = await Promise.all(
    chunks(unique).map((group) =>
      chunkedContractEvents(
        publicClient,
        { address: [...tokens], abi: erc20Abi, eventName: "Transfer", args: { [side]: group } },
        fromBlock,
        toBlock,
      ),
    ),
  )
  return (logs.flat() as RawLog[])
    .map((log) => ({
      token: log.address,
      from: log.args.from as Address,
      to: log.args.to as Address,
      value: log.args.value as bigint,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
    }))
    .sort(byPosition)
}

/**
 * The SIPA whose sweep made the portal deposit at `index` in `txHash`: the emitter of its `Sweep`
 * log. Undefined when the transaction holds no such sweep.
 */
export async function readSweptSipa(
  publicClient: PublicClient,
  txHash: Hex,
  index: bigint,
): Promise<Address | undefined> {
  const { logs } = await publicClient.getTransactionReceipt({ hash: txHash })
  const sweeps = parseEventLogs({ abi: SIPAAbi, eventName: "Sweep", logs } as never) as unknown as {
    address: Address
    args: { index: bigint }
  }[]
  return sweeps.find((log) => log.args.index === index)?.address
}
