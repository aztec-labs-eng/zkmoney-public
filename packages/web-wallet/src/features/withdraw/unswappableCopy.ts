/**
 * What to tell someone whose withdrawal escrow holds funds its run cannot deliver. A swap escrow
 * refuses a fill below its slippage floor and an ETH recipient that rejects ETH; which one it is
 * cannot be read off the record, so the copy names both and ends on the exit that is left. A
 * bridge-out whose bridge refunded holds the refund instead.
 */
import { escrowLeg, isBridgeRefund, type WithdrawalRecord } from "@obsidion/front-core"

/** The token a stuck escrow holds, as the exit names it. */
export const escrowHeldSymbol = (record: WithdrawalRecord): string =>
  isBridgeRefund(record) ? record.swapOutput ?? "DAI" : "DAI"

export function unswappableCopy(record: WithdrawalRecord): string {
  const held = escrowHeldSymbol(record)
  const refund = isBridgeRefund(record) ? record.bridgeOut : undefined
  const cause = refund
    ? `The bridge to ${refund.chainName} couldn't deliver and returned the ${held} to the escrow.`
    : record.swapOutput === "ETH"
    ? "The swap into ETH can't complete right now: the pool price is outside the escrow's limit, or the recipient address can't receive ETH."
    : `The swap into ${
        record.swapOutput ?? "the chosen asset"
      } can't complete right now: the pool price is outside the escrow's limit.`
  const exit = !escrowLeg(record)
    ? `The ${held} is safe in the escrow, but recovering it needs details this wallet didn't store.`
    : refund
    ? `The ${held} is safe in the escrow. You can recover it by sending it to an Ethereum address of your choice.`
    : "The DAI is safe in the escrow. You can recover it by sending it to an Ethereum address of your choice, or wait for the price to return."
  return `${cause} ${exit}`
}
