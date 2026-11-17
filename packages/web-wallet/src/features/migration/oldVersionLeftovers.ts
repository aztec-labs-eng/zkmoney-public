/**
 * Funds an old version still holds that no balance here shows: a Savings move that version closed
 * before it finished, and a payment link nobody claimed there.
 */
import {
  isOtherRollupLink,
  paylinkStatusIsUnspent,
  type FeedItem,
  type HoldingPrice,
  type MoveRecord,
} from "@obsidion/front-core"
import { isStrandedMove, savingsMoveDestination, savingsMoveFigure } from "../savings/savingsMove"
import type { SavingsAccount } from "../savings/AccountSwitcher/AccountSwitcher"

export interface OldVersionLeftovers {
  /** What stranded Savings moves left there, in 18-decimal USD. */
  savings: bigint
  /** Whether some of those moves reached their destination's old portal, where Withdraw can refund them. */
  deposited: Record<SavingsAccount, boolean>
  /** What unclaimed payment links hold there, in 18-decimal USD. */
  links: bigint
  linkCount: number
}

const CENT = 10n ** 16n

/**
 * `moves`: every Savings move; `items`: the feed's; `price`: a move's own holding's;
 * `network`: the wallet's.
 */
export function oldVersionLeftovers(o: {
  moves: readonly MoveRecord[]
  items: readonly FeedItem[]
  price(holdingId: string): HoldingPrice | undefined
  network: string | undefined
}): OldVersionLeftovers {
  let savings = 0n
  const deposited = { main: false, savings: false }
  for (const move of o.moves) {
    if (!isStrandedMove(move)) continue
    // What the destination holds, not what left the source with its fees.
    const destination = savingsMoveDestination(move)
    const price = o.price(move.holdingId)
    savings +=
      savingsMoveFigure(move, destination, price) ?? savingsMoveFigure(move, "main", price) ?? 0n
    deposited[destination] ||= !!move.deposit
  }
  const { network } = o
  const links = o.items.flatMap((item) =>
    item.kind === "link" &&
    item.funding === "settled" &&
    paylinkStatusIsUnspent(item.paylinkStatus) &&
    isOtherRollupLink(item.link, network)
      ? [item.link]
      : [],
  )
  const linkUsd = links.reduce((sum, link) => {
    const token = link.token
    return sum + BigInt(Math.round((token?.amount ?? 0) * (token?.price || 1) * 100)) * CENT
  }, 0n)
  return { savings, deposited, links: linkUsd, linkCount: links.length }
}
