import {
  assetUsd,
  holdingUsd,
  type HoldingPrice,
  type MoveDelay,
  type MoveRecord,
  type MoveState,
} from "@obsidion/front-core"
import type { SavingsAccount } from "./AccountSwitcher/AccountSwitcher"

/** The account a move's deposit lands in. */
export const savingsMoveDestination = (move: Pick<MoveRecord, "direction">): SavingsAccount =>
  move.direction === "in" ? "savings" : "main"

/** A move an old version's record shows unfinished when that version closed. It can't finish here. */
export const isStrandedMove = (move: Pick<MoveRecord, "phase">): boolean =>
  move.phase === "migrated"

/**
 * What a move's row and sheet say of it: `stranded` for one an old version left unfinished,
 * `delayed` with what its release waits on, else `moving` from submit until the destination claims
 * the deposit. A move whose escrow's DAI was recovered ends `recovered`.
 */
export type SavingsMoveStatus =
  | { kind: "stranded" | "failed" | "recovered" | "moving" }
  | { kind: "delayed"; reason: MoveDelay }

/** Undefined once the deposit is claimed. */
export function savingsMoveStatus(
  move: Pick<MoveRecord, "phase">,
  state: MoveState,
): SavingsMoveStatus | undefined {
  if (isStrandedMove(move)) return { kind: "stranded" }
  switch (state.kind) {
    case "failed":
    case "dropped":
      return { kind: "failed" }
    case "recovered":
      return { kind: "recovered" }
    case "done":
      return undefined
    case "delayed":
      return { kind: "delayed", reason: state.reason }
    default:
      return { kind: "moving" }
  }
}

/**
 * The dollar value of what the move burned: its amount moving in, the quoted redemption moving
 * out, which is in the vault's asset and so unknown until the vault is priced.
 */
export const moveValue = (
  move: Pick<MoveRecord, "direction" | "amount" | "quote">,
  price?: HoldingPrice,
) =>
  move.direction === "in"
    ? move.amount
    : move.quote && price && assetUsd(move.quote.expectedOut, price)

/** What the quote's conversion returns, in dollars: the vault's asset moving in, DAI moving out. */
export const moveNet = (move: Pick<MoveRecord, "direction" | "quote">, price?: HoldingPrice) =>
  move.direction === "out"
    ? move.quote?.conversionOut
    : move.quote && price && assetUsd(move.quote.conversionOut, price)

/**
 * The dollars a row shows for a move, as `perspective` sees it. A credit into Savings is what the
 * move put in, fixed from its record. The vault's asset and its shares are read at `price`, the
 * move's own holding's, and a figure in either is unknown until it is read.
 */
export function savingsMoveFigure(
  move: Pick<MoveRecord, "direction" | "amount" | "quote" | "deposit" | "assets">,
  perspective: SavingsAccount,
  price?: HoldingPrice,
): bigint | undefined {
  const into = move.direction === "in"
  const credit = into === (perspective === "savings")
  const assets = (amount: bigint) => price && assetUsd(amount, price)
  const shares = (amount: bigint) => price && holdingUsd(amount, price)
  if (into && credit) {
    const put = move.assets ?? move.quote?.conversionOut
    if (put !== undefined) return assets(put)
    return move.deposit ? shares(move.deposit.amount) : move.amount
  }
  if (credit && move.deposit) return move.deposit.amount
  // A move out's debit: what the vault paid for its shares, once read.
  if (!into && move.assets !== undefined) return assets(move.assets)
  if (credit) return move.quote?.conversionOut ?? shares(move.amount)
  return into || move.quote ? moveValue(move, price) : shares(move.amount)
}

/**
 * A swap's dollars: what left its source, its shares at `from`; what its destination takes in, at
 * `into`, as quoted; its fee, the shares the route did not keep at the quote's own rate, so it never
 * moves with the source's price; and once the route ran, what it took in, then the shares it
 * landed. Each is unknown until its vault is priced.
 */
export function vaultSwapFigures(
  move: Pick<MoveRecord, "amount" | "quote" | "deposit" | "assets">,
  from?: HoldingPrice,
  into?: HoldingPrice,
): { left?: bigint; fee?: bigint; net?: bigint; landed?: bigint } {
  const quoted = move.quote && into && assetUsd(move.quote.conversionOut, into)
  const landed =
    into &&
    (move.deposit
      ? holdingUsd(move.deposit.amount, into)
      : move.assets === undefined
      ? undefined
      : assetUsd(move.assets, into))
  return {
    ...(from ? { left: holdingUsd(move.amount, from) } : {}),
    ...(quoted === undefined || !move.quote?.routed
      ? {}
      : { net: quoted, fee: (quoted * (move.amount - move.quote.routed)) / move.quote.routed }),
    ...(landed === undefined ? {} : { landed }),
  }
}
