import { ActivityListRow, type StatusLabel } from "@obsidion/web-ds"
import {
  savingsMoveLabel,
  type HoldingPrice,
  type MoveDirection,
  type MoveRecord,
  type MoveState,
  type SavingsMoveEta,
} from "@obsidion/front-core"
import { fmt } from "../../../lib/fmt"
import { rowTimestamp, shortL1Addr, usdAtomicFloor } from "../../../ui/format"
import type { SavingsAccount } from "../AccountSwitcher/AccountSwitcher"
import shared from "../savingsMove.copy"
import {
  savingsMoveFigure,
  savingsMoveStatus,
  vaultSwapFigures,
  type SavingsMoveStatus,
} from "../savingsMove"
import { savingsEtaCopy } from "../savingsMoveTiming"
import copy from "./SavingsMoveRow.copy"
import styles from "./SavingsMoveRow.module.css"

/** The vault a priced move names; absent until its asset symbol is read. */
function vaultName(price: HoldingPrice | undefined): string | undefined {
  return price && fmt(shared.vaultName, { symbol: price.assetSymbol })
}

/** Names the vault once its symbol is read, else the account the move went between. */
function moveCounterparty(
  perspective: SavingsAccount,
  direction: MoveDirection,
  vault: string | undefined,
): string {
  if (!vault) return copy.counterparty[perspective][direction]
  if (perspective === "savings") return direction === "in" ? vault : copy.counterparty.savings.out
  return fmt(direction === "in" ? copy.toVault : copy.fromVault, { vault })
}

function statusLabel(status: SavingsMoveStatus, move: MoveRecord): StatusLabel {
  switch (status.kind) {
    case "stranded":
      return copy.stranded
    case "failed":
      return shared.failed
    case "recovered":
      return shared.recovered
    case "delayed":
      return shared.delayed
    case "moving":
      return move.intoHoldingId === undefined ? savingsMoveLabel(move.direction) : shared.switching
  }
}

/**
 * One move as the account `perspective` sees it: a credit on the side the funds land. A swap
 * stays in Savings, so its row shows what left, unsigned. The time is when the user moved (a
 * rebuilt move's burn time from chain), the same on every device.
 */
export function SavingsMoveRow({
  move,
  state,
  perspective,
  price,
  into,
  eta,
  onOpen,
}: {
  move: MoveRecord
  state: MoveState
  perspective: SavingsAccount
  /** The move's holding, once priced. */
  price?: HoldingPrice
  /** A swap's destination, once priced. */
  into?: HoldingPrice
  /** How long the move still takes, while it is in flight. */
  eta?: SavingsMoveEta
  onOpen: () => void
}) {
  const vaultSwapped = move.intoHoldingId !== undefined
  const credit = (move.direction === "in") === (perspective === "savings")
  const figure = vaultSwapped
    ? vaultSwapFigures(move, price, into).left
    : savingsMoveFigure(move, perspective, price)
  const vault = vaultName(price)
  const route = vaultSwapped
    ? fmt(copy.switchRoute, {
        from: price?.assetSymbol ?? copy.noFigure,
        to: into?.assetSymbol ?? copy.noFigure,
      })
    : fmt(copy.route[move.direction], { vault: vault ?? copy.savings })
  const status = savingsMoveStatus(move, state)
  // The pill names the route or the delay, so the subline carries the time left or the cause.
  const note = move.recoveredTo
    ? fmt(shared.recoveredTo, { address: shortL1Addr(move.recoveredTo) })
    : status?.kind === "delayed"
    ? copy.delay[status.reason]
    : eta && status?.kind === "moving"
    ? savingsEtaCopy(eta)
    : undefined
  return (
    <ActivityListRow
      counterparty={
        vaultSwapped ? copy.switched : moveCounterparty(perspective, move.direction, vault)
      }
      timestamp={`${note ?? route} · ${rowTimestamp(move.startTime)}`}
      amount={
        figure === undefined
          ? copy.noFigure
          : `${vaultSwapped ? "" : credit ? "+" : "-"}${usdAtomicFloor(figure)}`
      }
      statusLabel={status && statusLabel(status, move)}
      avatarIcon="earn"
      className={styles.row}
      onClick={onOpen}
      ariaLabel={copy.open}
    />
  )
}
