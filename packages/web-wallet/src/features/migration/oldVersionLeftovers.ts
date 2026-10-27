/**
 * Funds an old version still holds that no balance here shows: a Savings move that version closed
 * before it finished, and a payment link nobody claimed there.
 */
import type { SavingsMoveRecord, WithdrawalRecord } from "@obsidion/front-core"
import { isOtherRollupLink, paylinkStatusIsUnspent } from "../paylink/creatorLinkActions"
import {
  isStrandedSavingsMove,
  savingsMoveDestination,
  savingsMoveFigure,
} from "../savings/SavingsMoveRow"
import type { SavingsAccount } from "../savings/AccountSwitcher"
import type { ActivityRowView } from "../../ui/screens/activityView"

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

export function oldVersionLeftovers(o: {
  moves: readonly SavingsMoveRecord[]
  burns: readonly WithdrawalRecord[]
  rows: readonly ActivityRowView[]
  sharePrice?: bigint
}): OldVersionLeftovers {
  let savings = 0n
  const deposited = { main: false, savings: false }
  for (const move of o.moves) {
    const burn = o.burns.find((b) => b.localId === move.withdrawalLocalId)
    if (!isStrandedSavingsMove(move, burn)) continue
    // What the destination holds, not what left the source with its fees.
    const destination = savingsMoveDestination(move)
    savings +=
      savingsMoveFigure(move, destination, o.sharePrice, burn) ??
      savingsMoveFigure(move, "main", o.sharePrice, burn) ??
      0n
    deposited[destination] ||= !!move.deposit
  }
  const links = o.rows.filter(
    (row) =>
      row.status === "success" &&
      !!row.paylinkStatus &&
      paylinkStatusIsUnspent(row.paylinkStatus) &&
      !!row.paylinkRow &&
      isOtherRollupLink(row.paylinkRow),
  )
  const linkUsd = links.reduce((sum, row) => {
    const token = row.paylinkRow!.token
    return sum + BigInt(Math.round((token?.amount ?? 0) * (token?.price || 1) * 100)) * CENT
  }, 0n)
  return { savings, deposited, links: linkUsd, linkCount: links.length }
}
