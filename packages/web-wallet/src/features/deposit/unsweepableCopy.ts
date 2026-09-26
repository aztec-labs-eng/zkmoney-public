/**
 * What to tell someone holding a deposit no sweep can move. A sweep moves the whole balance, the
 * record's `fee` is the whole floor that comes off it, and the cap applies to what is forwarded, so
 * the window is `fee < gross ≤ cap + fee` and the record's own numbers name the reason at either
 * end of it.
 * Between them the cause is not in the record, so the copy offers the likeliest one without
 * claiming it. All three end on the exit that is left; the floor case also names the top-up.
 */
import { formatUnits } from "viem"
import { DEFAULT_DECIMALS, WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { TX_AMOUNT_CAP } from "@obsidion/sdk"
import { depositAmounts, type SIPADepositRecord } from "@obsidion/front-core"

type UnsweepableRecord = Pick<SIPADepositRecord, "amount" | "netAmount" | "fee" | "messageSecret"> &
  Partial<Pick<SIPADepositRecord, "tokenSymbol">>

const CAP_DISPLAY = formatUnits(TX_AMOUNT_CAP, DEFAULT_DECIMALS)

/** `settlementSymbol` is the deployment's settlement token — the picker's first entry. */
export function unsweepableCopy(record: UnsweepableRecord, settlementSymbol?: string): string {
  const { feeKnown, grossAtomic, feeAtomic, feeDisplay } = depositAmounts(record)
  // The fee is met by the token sent, scaled by its decimals alone; the cap is met by the settlement
  // token the swap forwards, so each figure is named in the token it is measured in.
  const feeLabel = `${feeDisplay} ${record.tokenSymbol || WALLET_TOKEN_SYMBOL}`
  const capLabel = `${CAP_DISPLAY} ${settlementSymbol || WALLET_TOKEN_SYMBOL}`
  // Only the forwarded amount meets the cap, so a known fee raises the ceiling by exactly that
  // much; without one the gross is the best stand-in the record offers.
  const forwarded = feeKnown ? grossAtomic - feeAtomic : grossAtomic
  // The note's message secret is half the recovery key: without it nothing can sign the exit.
  const recovery = record.messageSecret
    ? "recover the funds by sending them back out to an Ethereum address you control."
    : undefined
  const undiscovered =
    "Recovering the funds needs details this wallet hasn't discovered yet. Check back later."
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
      ? `This deposit is over the network's per-transaction deposit cap (${capLabel}), so it can't be moved into your private balance.`
      : "This deposit can't be moved into your private balance automatically. Its deposit address may already have been used once."
  const exit = recovery ? `You can ${recovery}` : undiscovered
  return `${cause} ${exit}`
}
