import {
  erc20Abi,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type PublicClient,
} from "viem"
import type { OriginChain } from "../../../engine/bridgeInTracker"

export type OriginClient = Pick<
  PublicClient,
  "getTransactionReceipt" | "getTransaction" | "getBlock" | "getTransactionCount" | "readContract"
>

/** Origin-chain reads over JSON-RPC; `client` gives each chain's client, or throws. */
export function rpcOriginChain(client: (chainId: number) => OriginClient): OriginChain {
  return {
    async receipt(chainId, hash) {
      try {
        return (await client(chainId).getTransactionReceipt({ hash })).status
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return undefined
        throw e
      }
    },
    async nonce(chainId, hash) {
      try {
        return (await client(chainId).getTransaction({ hash })).nonce
      } catch (e) {
        if (e instanceof TransactionNotFoundError) return undefined
        throw e
      }
    },
    async head(chainId) {
      const block = await client(chainId).getBlock({ blockTag: "latest" })
      return { number: block.number, time: Number(block.timestamp) * 1000 }
    },
    minedCount: (chainId, address, blockNumber) =>
      client(chainId).getTransactionCount(
        blockNumber === undefined ? { address, blockTag: "latest" } : { address, blockNumber },
      ),
    async minedIn(chainId, blockNumber, from, nonce) {
      const block = await client(chainId).getBlock({ blockNumber, includeTransactions: true })
      const tx = block.transactions.find(
        (t) => t.from.toLowerCase() === from.toLowerCase() && t.nonce === nonce,
      )
      return tx && { hash: tx.hash, to: tx.to, input: tx.input }
    },
    async token(chainId, address) {
      const read = { address, abi: erc20Abi } as const
      const [symbol, decimals] = await Promise.all([
        client(chainId).readContract({ ...read, functionName: "symbol" }),
        client(chainId).readContract({ ...read, functionName: "decimals" }),
      ])
      return { symbol, decimals }
    },
  }
}
