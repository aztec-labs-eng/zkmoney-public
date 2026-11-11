/** An in-memory fake of `OriginChain`; `fakeOriginChain.l1.test.ts` holds it to the real reader. */
import { vi } from "vitest"
import type { Address, Hex } from "viem"
import type { OriginChain } from "../../src/engine/bridgeInTracker"

export const CANCEL = `0x${"cc".repeat(32)}` as Hex
export const DEPOSITOR = `0x${"a1".repeat(20)}` as Address
const SPOKE_POOL = `0x${"b5".repeat(20)}` as Address
export const CALL = { to: SPOKE_POOL, data: "0xb0b0" as Hex }

export interface ChainTx {
  hash: Hex
  from: Address
  nonce: number
  to: Address
  input: Hex
  status: "success" | "reverted"
}

/**
 * The origin chain's RPC: blocks of mined transactions, and what its mempool holds. `time` is the
 * head's timestamp in ms; `fail` makes every read throw.
 */
export function fakeChain(token = { symbol: "USDC", decimals: 6 }) {
  const blocks: ChainTx[][] = [[]]
  const mempool = new Map<string, number>()
  const state = { fail: undefined as Error | undefined, time: 0 }
  const all = () => blocks.flat()
  const read = <A extends unknown[], R>(fn: (...args: A) => R) =>
    vi.fn(async (...args: A) => {
      if (state.fail) throw state.fail
      return fn(...args)
    })
  const origin = {
    receipt: read((_: number, hash: Hex) => all().find((tx) => tx.hash === hash)?.status),
    nonce: read(
      (_: number, hash: Hex) => mempool.get(hash) ?? all().find((tx) => tx.hash === hash)?.nonce,
    ),
    head: read(() => ({ number: BigInt(blocks.length - 1), time: state.time })),
    minedCount: read(
      (_: number, from: Address, block?: bigint) =>
        blocks
          .slice(0, block === undefined ? undefined : Number(block) + 1)
          .flat()
          .filter((tx) => tx.from === from).length,
    ),
    minedIn: read((_: number, block: bigint, from: Address, nonce: number) => {
      const tx = blocks[Number(block)]?.find((t) => t.from === from && t.nonce === nonce)
      return tx && { hash: tx.hash, to: tx.to, input: tx.input }
    }),
    token: read(() => token),
  } satisfies OriginChain
  return {
    origin,
    state,
    /** Broadcasts `hash` with `nonce`; the RPC sees it unless `unseen`. */
    send(hash: Hex, nonce: number, unseen = false) {
      if (!unseen) mempool.set(hash, nonce)
    },
    /** Mines `txs` in a new block, after `empty` empty blocks. */
    mine(txs: Partial<ChainTx>[], empty = 0) {
      for (let i = 0; i < empty; i++) blocks.push([])
      blocks.push(
        txs.map((tx) => ({
          hash: CANCEL,
          from: DEPOSITOR,
          nonce: 0,
          to: SPOKE_POOL,
          input: CALL.data,
          status: "success",
          ...tx,
        })),
      )
      for (const tx of txs) if (tx.hash) mempool.delete(tx.hash)
    },
    /** `from`'s earlier transactions, each in its own block. */
    history(count: number, from = DEPOSITOR) {
      for (let nonce = 0; nonce < count; nonce++)
        this.mine([{ hash: `0x${nonce.toString(16).padStart(64, "0")}` as Hex, from, nonce }])
    },
  }
}
