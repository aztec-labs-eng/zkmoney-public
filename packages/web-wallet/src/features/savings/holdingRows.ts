import { assetUsd } from "@obsidion/front-core"
import type { HoldingCopy, HoldingWords } from "../../config/env"
import type { SavingsLine, SavingsLineFigures } from "./savingsLine"

/** One line of "You're earning on". */
export interface HoldingRowView {
  /** The line's holding id. */
  id: string
  /** The vault asset's symbol; absent until the line is priced. */
  symbol?: string
  /** What the profile says of it; absent without words. */
  words?: HoldingWords
  isNew: boolean
  /** The profile no longer lists it: funds can only leave. */
  exitOnly: boolean
  /** The account holds shares of it. */
  held: boolean
  /** In dollars at `DEFAULT_DECIMALS`; absent while held shares are unpriced. */
  value?: bigint
  /** The yearly rate at `RATE_SCALE`; absent when unread. */
  rate?: bigint
}

/**
 * A Savings line as a row, named by the profile's words. `vaultSwapping`, in dollars, is what a swap
 * out of it carries until the vault it lands in holds it.
 */
export function holdingRow(
  { line, price, shares, position }: SavingsLineFigures,
  words: HoldingCopy,
  vaultSwapping = 0n,
): HoldingRowView {
  const own = Object.hasOwn(words, line.id) ? words[line.id] : undefined
  const rate = position?.rate ?? price?.rate
  return {
    id: line.id,
    ...(price ? { symbol: price.assetSymbol } : {}),
    ...(own ? { words: own } : {}),
    isNew: !line.exitOnly && own?.new === true,
    exitOnly: line.exitOnly,
    held: (shares ?? 0n) > 0n,
    ...(position
      ? { value: assetUsd(position.value, position) + vaultSwapping }
      : shares === 0n
      ? { value: vaultSwapping }
      : {}),
    ...(rate === undefined ? {} : { rate }),
  }
}

/** Savings' rows in line order; empty until every line is read. */
export function selectHoldingRows(
  savings: SavingsLine,
  words: HoldingCopy,
  vaultSwapping: ReadonlyMap<string, bigint> = new Map(),
): HoldingRowView[] {
  return savings.hydrated
    ? savings.lines.map((figures) => holdingRow(figures, words, vaultSwapping.get(figures.line.id)))
    : []
}
