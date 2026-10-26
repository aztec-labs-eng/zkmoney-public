import { SavingsMoveStorage } from "@obsidion/front-core"
import type { Address, Hex } from "viem"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

let store: SavingsMoveStorage | undefined

/** The moves this browser made, one store per page load. */
export function getSavingsMoveStore(): SavingsMoveStorage {
  return (store ??= new SavingsMoveStorage(webStorage))
}

/**
 * Marks recovered each old version's move whose deposit a refund to `to` in `txHash` returned. A leaf
 * index names a deposit only within its rollup's Inbox, so the amount must match too.
 */
export async function noteRefundedSavingsMoves(
  deposits: readonly { leafIndex: string; amount: string }[],
  to: Address,
  txHash: Hex,
) {
  if (!deposits.length) return
  const moves = getSavingsMoveStore()
  await moves.load()
  for (const move of moves.list()) {
    const deposit = move.deposit
    if (
      move.retired &&
      !move.recovered &&
      deposit &&
      deposits.some((d) => d.leafIndex === deposit.inboxIndex && d.amount === deposit.amount)
    )
      await moves.put({ ...move, recovered: { to, txHashes: [txHash] } })
  }
}
