import { holdingUsd, type HoldingPrice, type MoveDirection } from "@obsidion/front-core"
import { fmt } from "../../lib/fmt"
import { usdAtomicFloor } from "../../ui/format"
import copy from "./moveSummary.copy"

/**
 * What the tray and the bell call a move while it sends: its dollar value and where it goes, the
 * shares of a move out or a swap priced at their holding's price. Without a price the line names
 * only the route.
 */
export function moveSummary(
  route: MoveDirection | "vaultSwap",
  amount: bigint,
  price?: HoldingPrice,
): string {
  const to = { in: copy.savings, out: copy.main, vaultSwap: copy.vault }[route]
  const value =
    route === "in" ? amount : price === undefined ? undefined : holdingUsd(amount, price)
  return value === undefined
    ? fmt(copy.unpriced, { to })
    : fmt(copy.priced, { value: usdAtomicFloor(value), to })
}
