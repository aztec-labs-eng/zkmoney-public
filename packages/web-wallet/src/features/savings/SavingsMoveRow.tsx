import { ActivityListRow, type StatusLabel } from "@obsidion/web-ds"
import {
  savingsMoveLabel,
  savingsValue,
  type MoveRecord,
  type MoveState,
  type SavingsMoveEta,
} from "@obsidion/front-core"
import { rowTimestamp, shortL1Addr, usdAtomicFloor } from "../../ui/format"
import type { SavingsAccount } from "./AccountSwitcher"
import { savingsEtaCopy } from "./savingsMoveTiming"

const LABEL: Record<SavingsAccount, Record<MoveRecord["direction"], string>> = {
  main: { in: "To Savings", out: "From Savings" },
  savings: { in: "From Main Account", out: "To Main Account" },
}

/** The account a move's deposit lands in. */
export const savingsMoveDestination = (move: Pick<MoveRecord, "direction">): SavingsAccount =>
  move.direction === "in" ? "savings" : "main"

/** A move an old version's record shows unfinished when that version closed. It can't finish here. */
export const isStrandedMove = (move: Pick<MoveRecord, "phase">): boolean =>
  move.phase === "migrated"

/** A stranded move's status. */
export const STRANDED_STATUS: StatusLabel = "Needs recovery"

/**
 * One state from submit until the destination claims the deposit, like a deposit's row; nothing
 * once claimed. A move whose escrow's DAI was recovered ends there.
 */
export function savingsMoveStatus(
  move: Pick<MoveRecord, "phase" | "direction">,
  state: MoveState,
): StatusLabel | undefined {
  if (isStrandedMove(move)) return STRANDED_STATUS
  switch (state.kind) {
    case "failed":
    case "dropped":
      return "Failed"
    case "recovered":
      return "Recovered"
    case "done":
      return undefined
    default:
      return savingsMoveLabel(move.direction)
  }
}

/** Where a recovered move's funds went, for its row and its sheet. */
export const recoveredTo = (move: Pick<MoveRecord, "recoveredTo">): string | undefined =>
  move.recoveredTo && `Recovered to ${shortL1Addr(move.recoveredTo)}`

/** The DAI value of what the move burned: its amount moving in, the quoted redemption moving out. */
export const moveValue = (move: Pick<MoveRecord, "direction" | "amount" | "quote">) =>
  move.direction === "in" ? move.amount : move.quote?.expectedOut

/**
 * The dollars a row shows for a move, as `perspective` sees it. A credit into Savings is what the
 * move put in, fixed from its record; sUSDS shares are priced at the vault's share price, never
 * shown as a count, and a figure with no price or record yet is unknown.
 */
export function savingsMoveFigure(
  move: Pick<MoveRecord, "direction" | "amount" | "quote" | "deposit" | "assets">,
  perspective: SavingsAccount,
  sharePrice?: bigint,
): bigint | undefined {
  const into = move.direction === "in"
  const credit = into === (perspective === "savings")
  const priced = (shares: bigint) =>
    sharePrice === undefined ? undefined : savingsValue(shares, sharePrice)
  if (into && credit) {
    return (
      move.assets ??
      move.quote?.conversionOut ??
      (move.deposit ? priced(move.deposit.amount) : move.amount)
    )
  }
  if (credit && move.deposit) return move.deposit.amount
  // A move out's debit: the USDS the vault paid for its shares, once read.
  if (!into && move.assets !== undefined) return move.assets
  const fallback = into ? move.amount : priced(move.amount)
  return (credit ? move.quote?.conversionOut : moveValue(move)) ?? fallback
}

/**
 * One move as the account `perspective` sees it: a credit on the side the funds land. The time is
 * when the user moved (a rebuilt move's burn time from chain), the same on every device.
 */
export function SavingsMoveRow({
  move,
  state,
  perspective,
  sharePrice,
  eta,
  onOpen,
}: {
  move: MoveRecord
  state: MoveState
  perspective: SavingsAccount
  /** The vault's share price, once the position has been read. */
  sharePrice?: bigint
  /** How long the move still takes, while it is in flight. */
  eta?: SavingsMoveEta
  onOpen: () => void
}) {
  const credit = (move.direction === "in") === (perspective === "savings")
  const figure = savingsMoveFigure(move, perspective, sharePrice)
  const status = savingsMoveStatus(move, state)
  // While the move is in flight the pill names the route, so the subline carries the time left.
  const note =
    recoveredTo(move) ??
    (eta && status === savingsMoveLabel(move.direction) ? savingsEtaCopy(eta) : undefined)
  const route = move.direction === "in" ? "Main Account → Savings" : "Savings → Main Account"
  return (
    <ActivityListRow
      counterparty={LABEL[perspective][move.direction]}
      timestamp={`${note ?? route} · ${rowTimestamp(move.startTime)}`}
      amount={figure === undefined ? "—" : `${credit ? "+" : "-"}${usdAtomicFloor(figure)}`}
      statusLabel={status}
      avatarIcon="earn"
      className="ww-savings-move-row"
      onClick={onOpen}
      ariaLabel="Open move details"
    />
  )
}
