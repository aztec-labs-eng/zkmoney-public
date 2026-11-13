import { holdingUsd, type HoldingPrice, type MoveDirection } from "@obsidion/front-core"
import { fmt } from "../../lib/fmt"
import { usdAtomicFloor } from "../../ui/format"
import copy from "./moveSummary.copy"

/**
 * What the tray and the bell call a move while it sends: its dollar value and where it goes, the
 * shares of a move out priced at their holding's price. Without a price the line names only the
 * route.
 */
export function moveSummary(
  direction: MoveDirection,
  amount: bigint,
  price?: HoldingPrice,
): string {
  const to = direction === "in" ? copy.savings : copy.main
  const value =
    direction === "in" ? amount : price === undefined ? undefined : holdingUsd(amount, price)
  return value === undefined
    ? fmt(copy.unpriced, { to })
    : fmt(copy.priced, { value: usdAtomicFloor(value), to })
}
