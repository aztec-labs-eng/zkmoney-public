import { selectEntry, type BalanceEntry } from "../../../engine/balances"
import type { RecordSet } from "../../../engine/persistentStore"
import type { Loaded } from "../../../engine/recordSource"
import { isSavingsMovePending, needsVaultFigures } from "../../../oxide/savingsMoves"
import type { WithdrawalRecord } from "../bridge/types"
import { savingsValue } from "./savingsMath"
import type { SavingsMoveRecord, SavingsPosition, SavingsPrice, SavingsSource } from "./types"

export interface SavingsHolding {
  position: SavingsPosition | null
  /** True once the shares held are known and the first price read has answered, with a price or not. */
  hydrated: boolean
}

/** The shares the wallet's sync stored under the Savings token, valued at the vault's price. */
export function selectSavingsHolding(
  source: Pick<SavingsSource, "balance"> | null,
  balances: RecordSet<BalanceEntry>,
  price: SavingsPrice | null | undefined,
): SavingsHolding {
  const entry = source && selectEntry(balances, source.balance.scope, source.balance.tokenAddress)
  const shares = entry?.atomic
  if (shares === undefined || price === undefined) return { position: null, hydrated: false }
  return {
    position: price && {
      shares,
      value: savingsValue(shares, price.sharePrice),
      ...price,
      sharesReadAt: entry?.readAt,
      sharesAnchor: entry?.anchor,
      sharesToken: entry?.token,
    },
    hydrated: true,
  }
}

export const sameHolding = (a: SavingsHolding, b: SavingsHolding) =>
  a.hydrated === b.hydrated &&
  a.position?.shares === b.position?.shares &&
  a.position?.sharePrice === b.position?.sharePrice &&
  a.position?.apy === b.position?.apy &&
  a.position?.readAt === b.position?.readAt &&
  a.position?.sharesReadAt === b.position?.sharesReadAt &&
  a.position?.sharesAnchor === b.position?.sharesAnchor &&
  a.position?.sharesToken === b.position?.sharesToken

/** What the settle pass has left: burns it has not adopted, and whether any move waits on it. */
export interface SettleDue {
  due: boolean
  unadopted: number
}

/**
 * Whether a settle pass has work. A failed burn funded nothing, so its move waits on no pass. Until
 * the burns load, an unadopted one may be among them.
 */
export function selectSettleDue(
  moves: readonly SavingsMoveRecord[],
  burns: Loaded<WithdrawalRecord>,
): SettleDue {
  const unadopted = burns.records.filter(
    (burn) =>
      burn.skyMove &&
      burn.phase !== "failed" &&
      !moves.some((move) => move.withdrawalLocalId === burn.localId),
  ).length
  const failed = new Set(
    burns.records.filter((burn) => burn.phase === "failed").map((burn) => burn.localId),
  )
  const waiting = moves.some(
    (move) =>
      !failed.has(move.withdrawalLocalId) &&
      (isSavingsMovePending(move) || needsVaultFigures(move)),
  )
  return { due: !burns.hydrated || unadopted > 0 || waiting, unadopted }
}

export const sameSettleDue = (a: SettleDue, b: SettleDue) =>
  a.due === b.due && a.unadopted === b.unadopted
