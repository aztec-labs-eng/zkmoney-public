/**
 * What to tell someone holding a deposit no sweep can move. A sweep moves the whole balance, the
 * record's `fee` is the whole floor that comes off it, and the per-operation ceiling applies to what
 * is forwarded, so the window is `fee < gross ≤ ceiling + fee` and the record's own numbers name the
 * reason at either end of it.
 * Between them the cause is not in the record, so the copy offers the likeliest one without
 * claiming it. All three end on the exit that is left; the floor case also names the top-up.
 *
 * The ceiling is an internal protocol figure and is never shown. Refill cannot lift it, so that case
 * says waiting will not help and points to the published per-deposit limit instead.
 */
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { TX_AMOUNT_CAP } from "@obsidion/sdk"
import { depositAmounts, isNativeEth, type SIPADepositRecord } from "@obsidion/front-core"
import { DEPOSIT_LIMIT_BASIS, formatPublicLimit, nominalValuationNote } from "../limits/publicLimit"

type UnsweepableRecord = Pick<SIPADepositRecord, "amount" | "netAmount" | "fee" | "messageSecret"> &
  Partial<Pick<SIPADepositRecord, "tokenSymbol" | "tokenAddress">>

export function unsweepableCopy(record: UnsweepableRecord): string {
  const { feeKnown, grossAtomic, feeAtomic, feeDisplay } = depositAmounts(record)
  const symbol = record.tokenSymbol || WALLET_TOKEN_SYMBOL
  // The fee is met by the token sent, scaled by its decimals alone.
  const feeLabel = `${feeDisplay} ${symbol}`
  // Only the forwarded amount meets the ceiling, so a known fee raises it by exactly that much;
  // without one the gross is the best stand-in the record offers.
  const forwarded = feeKnown ? grossAtomic - feeAtomic : grossAtomic
  // The note's message secret is half the recovery key: without it nothing can sign the exit.
  const recovery = record.messageSecret
    ? "recover the funds by sending them back out to an Ethereum address you control."
    : undefined
  const undiscovered =
    "Recovering the funds needs details this wallet hasn't discovered yet. Check back later."
  if (isNativeEth(record.tokenAddress)) {
    const cause =
      "This deposit address received ETH, which can't be moved into your private balance."
    return `${cause} ${recovery ? `You can ${recovery}` : undiscovered}`
  }
  if (feeKnown && grossAtomic <= feeAtomic) {
    // A sweep takes the whole balance once it exceeds the fee, and the relayer re-queues a SIPA on
    // any later transfer into it, so a top-up releases the deposit with no further action. That is
    // the first way out; recovery is the alternative.
    const topUp = `Sending more to the same deposit address, so it holds more than ${feeLabel} in total, lets it move automatically.`
    const exit = recovery ? `Alternatively, you can ${recovery}` : undiscovered
    return `This deposit is at or below the network's deposit fee (${feeLabel}), so it can't be moved into your private balance. ${topUp} ${exit}`
  }
  const cause =
    forwarded > TX_AMOUNT_CAP
      ? `This deposit is larger than the network can process in one deposit, so it can't be moved into your private balance. Waiting won't change this. Each deposit is limited to ${formatPublicLimit()} ${DEPOSIT_LIMIT_BASIS}. ${nominalValuationNote(
          symbol,
        )}`
      : "This deposit can't be moved into your private balance automatically. Its deposit address may already have been used once."
  const exit = recovery ? `You can ${recovery}` : undiscovered
  return `${cause} ${exit}`
}
