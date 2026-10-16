import { parseUnits } from "viem"
import { DEFAULT_DECIMALS, PaylinkActionEnum } from "@obsidion/core/constants"
import {
  isSettledSipaPhase,
  savingsValue,
  type SIPADepositRecord,
  type SavingsMoveRecord,
  type Transaction,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { migrationAmounts } from "../../features/migration/migrationFee"
import { isSavingsMoveSettled } from "../../features/savings/SavingsMoveRow"
import { neverCreditsL2 } from "./activityView"

/** Funds on their way into each balance, in base units. */
export interface ArrivingFunds {
  main: bigint
  savings: bigint
}

/**
 * What each balance is owed but does not hold yet, at what will land, so a balance never drops when
 * funds arrive. A deposit counts once its sweep fixes the net; a migration or a Savings move counts
 * once its burn has left the source balance, at its quote (or, rebuilt from a rescan, what its burn
 * should land), then at its deposit once the escrow has run.
 */
export function arrivingFunds({
  deposits,
  burns,
  moves,
  sharePrice,
  transactions,
}: {
  deposits: readonly SIPADepositRecord[]
  burns: readonly WithdrawalRecord[]
  moves: readonly SavingsMoveRecord[]
  /** Prices a move's landed shares; without it the quote stands. */
  sharePrice?: bigint
  transactions: readonly Transaction[]
}): ArrivingFunds {
  let main = 0n
  let savings = 0n
  const swept = (record: SIPADepositRecord) =>
    record.phase === "pendingClaim" && record.netAmount != null
  const depositBySipa = new Map(deposits.map((d) => [d.sipaAddress.toLowerCase(), d] as const))
  // A burn still proving has not left its source yet.
  const left = (burn?: WithdrawalRecord) =>
    !!burn && burn.phase !== "submitting" && burn.phase !== "failed"

  for (const record of deposits) if (swept(record)) main += BigInt(record.netAmount!)

  for (const burn of burns) {
    if (burn.intent !== "migration" || !left(burn)) continue
    const arrival = depositBySipa.get(burn.recipient.toLowerCase())
    if (
      arrival &&
      (swept(arrival) || isSettledSipaPhase(arrival.phase) || neverCreditsL2(arrival.phase))
    )
      continue
    main += migrationAmounts(burn)?.netAtomic ?? 0n
  }

  const burnById = new Map(burns.map((burn) => [burn.localId, burn] as const))
  for (const move of moves) {
    const burn = burnById.get(move.withdrawalLocalId)
    if (!left(burn) || isSavingsMoveSettled(move, burn)) continue
    const into = move.direction === "in"
    const landed = move.deposit && BigInt(move.deposit.amount)
    const expected = move.net ?? move.expectedNet
    const figure =
      landed !== undefined && (!into || sharePrice !== undefined)
        ? into
          ? savingsValue(landed, sharePrice!)
          : landed
        : expected === undefined
        ? 0n
        : BigInt(expected)
    if (into) savings += figure
    else main += figure
  }

  for (const tx of transactions) {
    const inbound = tx.action === PaylinkActionEnum.CLAIM || tx.action === "faucet"
    if (
      tx.status !== "pending" ||
      !inbound ||
      !("token" in tx) ||
      !tx.token ||
      tx.token.hasUnknownAmount
    )
      continue
    main += parseUnits(tx.token.amount.toFixed(DEFAULT_DECIMALS), DEFAULT_DECIMALS)
  }

  return { main, savings }
}
