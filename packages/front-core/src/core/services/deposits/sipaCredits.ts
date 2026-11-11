import { formatUnits } from "viem"
import { DEFAULT_DECIMALS, WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import type { SipaDeposit, SIPASweep } from "../../../engine/sipaDeposits"

/** One payment an address took: the record as it reads for that payment. */
export interface SipaCredit {
  record: SipaDeposit
  /** The inbox index of the sweep of a past payment split out of the record; absent on its own view. */
  payment?: string
}

/**
 * The inbox index of the sweep the record's own fields describe. None while its payment has no
 * sweep yet: an address paid again keeps its last claimed index until the new payment is swept.
 */
export function sipaPaymentIndex(
  record: Pick<SipaDeposit, "phase" | "inboxIndex" | "claimedInboxIndexes" | "sweeps">,
): string | undefined {
  const index = record.inboxIndex
  if (!index || record.phase === "claimed") return index
  const claimed =
    !!record.claimedInboxIndexes?.includes(index) ||
    !!record.sweeps?.some((sweep) => sweep.inboxIndex === index)
  return claimed ? undefined : index
}

/** Whether `record` reads as its address's first payment, the one any registration fee came out of. */
export function isFirstSipaPayment(record: SipaDeposit): boolean {
  const first = record.sweeps?.[0]?.inboxIndex
  return !first || sipaPaymentIndex(record) === first
}

/**
 * The payments a SIPA record stands for, in payment order. An address can be paid again once its
 * sweep is claimed, and each claimed sweep is in the record's ledger: the record reads as its latest
 * or in-flight payment, and every other claimed sweep as a claimed payment of its own. The claimed
 * payments of an address paid more than once are dated by their sweeps, which every device reads
 * alike.
 */
export function sipaCredits(record: SipaDeposit): SipaCredit[] {
  const sweeps = record.sweeps ?? []
  const current = sipaPaymentIndex(record)
  const past = sweeps.filter((sweep) => sweep.inboxIndex !== current)
  if (past.length === 0) return [{ record }]
  const own = sweeps.find((sweep) => sweep.inboxIndex === current)
  return [
    ...past.map((sweep) => ({ payment: sweep.inboxIndex, record: creditOf(record, sweep) })),
    { record: own?.settledAt === undefined ? record : { ...record, startTime: own.settledAt } },
  ]
}

/**
 * A past payment: the record as it read once `sweep` was claimed. A sweep that names no token
 * credited the wallet token, whatever the record's later funding names, ETH included.
 */
function creditOf(record: SipaDeposit, sweep: SIPASweep): SipaDeposit {
  const decimals = sweep.tokenDecimals ?? DEFAULT_DECIMALS
  const at = sweep.settledAt ?? record.startTime
  return {
    ...record,
    phase: "claimed",
    amount: formatUnits(BigInt(sweep.netAmount), decimals),
    netAmount: sweep.netAmount,
    fee: sweep.fee,
    tokenAddress: sweep.tokenAddress,
    rowToken: undefined,
    tokenSymbol: sweep.tokenSymbol ?? WALLET_TOKEN_SYMBOL,
    tokenDecimals: decimals,
    fundingTokenSymbol: sweep.fundingTokenSymbol ?? sweep.tokenSymbol,
    inboxIndex: sweep.inboxIndex,
    sweepTxHash: sweep.sweepTxHash,
    recoveryTxHash: undefined,
    claimLanded: undefined,
    pendingSweeps: undefined,
    failure: undefined,
    startTime: at,
    endTime: at,
  }
}
