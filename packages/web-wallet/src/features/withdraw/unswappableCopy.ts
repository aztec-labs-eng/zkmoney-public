/**
 * What to tell someone whose swap escrow holds DAI its route cannot deliver. The escrow refuses a
 * fill below its slippage floor and an ETH recipient that rejects ETH; which one it is cannot be
 * read off the record, so the copy names both and ends on the exit that is left.
 */
import { swapEscrowTarget, type WithdrawalRecord } from "@obsidion/front-core"

export function unswappableCopy(record: WithdrawalRecord): string {
  const cause =
    record.swapOutput === "ETH"
      ? "The swap into ETH can't complete right now: the pool price is outside the escrow's limit, or the recipient address can't receive ETH."
      : `The swap into ${
          record.swapOutput ?? "the chosen asset"
        } can't complete right now: the pool price is outside the escrow's limit.`
  const exit = swapEscrowTarget(record)
    ? "The DAI is safe in the escrow. You can recover it by sending it to an Ethereum address of your choice, or wait for the price to return."
    : "The DAI is safe in the escrow, but recovering it needs details this wallet didn't store."
  return `${cause} ${exit}`
}
