import { parseUnits } from "viem"
import { DEFAULT_DECIMALS, PaylinkActionEnum } from "@obsidion/core/constants"
import {
  isAccountMoveSipa,
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

/** Funds each balance is owed but does not hold yet, in base units. */
export interface ArrivingFunds {
  main: bigint
  savings: bigint
}

/**
 * What each balance is owed but does not hold yet, at what will land, so a balance never drops when
 * funds arrive. A deposit counts once its sweep fixes the net; a migration or a Savings move counts
 * once its burn has left the source balance, at its quote, then at its deposit once the escrow has
 * run, until its destination's balance is read after this device stored the claim. A move rebuilt
 * from a rescan has no quote and counts only from its deposit: its funds may already be in the
 * balance, claimed and spent before this device existed. An upgrade's own deposits never count: the
 * upgrade lock holds Home's figure until the balance holds them.
 */
export function arrivingFunds({
  deposits,
  burns,
  moves,
  sharePrice,
  transactions,
  balanceReadAt = {},
  upgradeRecipients = new Set(),
  oldVersions = { main: 0n, savings: 0n },
}: {
  deposits: readonly SIPADepositRecord[]
  burns: readonly WithdrawalRecord[]
  moves: readonly SavingsMoveRecord[]
  /** Prices a move's landed shares; without it the quote stands. */
  sharePrice?: bigint
  transactions: readonly Transaction[]
  /** When each stored balance's read resolved, ms. */
  balanceReadAt?: { main?: number; savings?: number }
  /** Every deposit address an upgrade's batches pay. */
  upgradeRecipients?: ReadonlySet<string>
  /** What the account holds on old versions. */
  oldVersions?: ArrivingFunds
}): ArrivingFunds {
  let main = 0n
  let savings = 0n
  const swept = (record: SIPADepositRecord) =>
    record.phase === "pendingClaim" && record.netAmount != null
  const depositBySipa = new Map(deposits.map((d) => [d.sipaAddress.toLowerCase(), d] as const))
  // A burn still proving has not left its source yet.
  const left = (burn?: WithdrawalRecord) =>
    !!burn && burn.phase !== "submitting" && burn.phase !== "failed"
  // A SIPA the account pays itself is not a deposit the user waits on.
  const upgradeDeposit = (record: SIPADepositRecord) =>
    isAccountMoveSipa(record) || upgradeRecipients.has(record.sipaAddress.toLowerCase())

  // A read resolved after a claim landed holds it, though the record still awaits `claimed`.
  const held = ({ claimLanded, inboxIndex }: SIPADepositRecord) =>
    !!claimLanded &&
    claimLanded.inboxIndex === inboxIndex &&
    (balanceReadAt.main ?? 0) >= claimLanded.at

  for (const record of deposits)
    if (swept(record) && !held(record) && !upgradeDeposit(record)) main += BigInt(record.netAmount!)

  main += oldVersions.main
  savings += oldVersions.savings

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
    const into = move.direction === "in"
    const storedAt = move.deposit?.claimed ? move.deposit.storedAt : undefined
    const unread =
      storedAt !== undefined && (balanceReadAt[into ? "savings" : "main"] ?? 0) < storedAt
    if (!left(burn) || (isSavingsMoveSettled(move, burn) && !unread)) continue
    const landed = move.deposit && BigInt(move.deposit.amount)
    const figure =
      landed !== undefined && (!into || sharePrice !== undefined)
        ? into
          ? savingsValue(landed, sharePrice!)
          : landed
        : move.net === undefined
        ? 0n
        : BigInt(move.net)
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
