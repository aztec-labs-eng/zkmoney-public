import {
  backfillSavingsMoveFigures,
  isSavingsMovePending,
  needsVaultFigures,
  savingsMoveOfWithdrawal,
  settleSavingsMove,
  type SavingsMoveSettleDeps,
} from "../../../oxide/savingsMoves"
import { WalletError } from "../../../engine/errors"
import { logger } from "../../../utils/logger"
import type { WithdrawalRecord } from "../bridge/types"
import type { SavingsMoves } from "../../../engine/savingsMoves"
import type { SavingsMoveRecord } from "./types"

/** Burns with Sky meta the store does not know: a rescan rebuilt them, or a reload cut the move short. */
async function adoptSavingsMoves(store: SavingsMoves, withdrawals: WithdrawalRecord[]) {
  const known = new Set((await store.all()).map((move) => move.withdrawalLocalId))
  for (const record of withdrawals) {
    if (record.phase === "failed" || known.has(record.localId)) continue
    const move = savingsMoveOfWithdrawal(record)
    if (move)
      await store.update(record.localId, (current) =>
        current ? null : { ...move, startTime: record.startTime },
      )
  }
}

/** The first line of a refusal, short enough for a row. */
export function claimRefusalMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text
    .split("\n")[0]
    .replace(/^Error:\s*/, "")
    .trim()
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

const laterBlock = (a?: string, b?: string): string | undefined =>
  a === undefined ? b : b === undefined ? a : BigInt(a) > BigInt(b) ? a : b

type ScanRange = Pick<SavingsMoveRecord, "depositScanFrom" | "depositScanFloor">
const floorOf = (range: ScanRange) =>
  range.depositScanFloor === undefined ? -1n : BigInt(range.depositScanFloor)
const defined = (range: ScanRange): ScanRange => ({
  ...(range.depositScanFrom !== undefined ? { depositScanFrom: range.depositScanFrom } : {}),
  ...(range.depositScanFloor !== undefined ? { depositScanFloor: range.depositScanFloor } : {}),
})

/**
 * The search range to keep when a pass and another writer both moved it: the one whose floor is
 * higher (the tighter, better-known start: the move flow's head at the burn beats a floor a pass
 * estimated), else the later cursor of the same range. A cursor never moves backwards within its
 * range.
 */
function scanRange(current: ScanRange, pass: ScanRange): ScanRange {
  const a = floorOf(current)
  const b = floorOf(pass)
  if (a !== b) return defined(a > b ? current : pass)
  return defined({
    depositScanFrom: laterBlock(current.depositScanFrom, pass.depositScanFrom),
    depositScanFloor: current.depositScanFloor,
  })
}

export interface SavingsSettlePassDeps extends SavingsMoveSettleDeps {
  /** Re-reads the balances, so a claim stored now shows in its destination's balance. */
  refreshBalance?: () => Promise<void>
  /** Stops the pass before its next move. */
  signal?: AbortSignal
}

/**
 * One pass over every pending move: adopt the ones only the burn records know, then find and claim
 * each one's deposit. A burn that failed is left alone; it funded nothing. Each pass leaves what it
 * found on the record, so a row can say why the move still waits. A claim stored now keeps when, and
 * the balances are read at once; until its destination's balance is read after it, the move still
 * counts as funds on their way. The session's settle task runs one pass at a time.
 */
export async function settleSavingsMoves(
  store: SavingsMoves,
  deps: SavingsSettlePassDeps,
  withdrawals: WithdrawalRecord[] = [],
  /** A found deposit the claim refused; the next pass tries again. */
  onClaimError: (move: SavingsMoveRecord, error: unknown) => void = () => {},
  now: () => number = Date.now,
): Promise<void> {
  const stopIfAborted = () => {
    if (deps.signal?.aborted) throw new WalletError("aborted", "savings settle pass aborted")
  }
  // A move list that does not read rejects here: the pass settles nothing over it.
  await adoptSavingsMoves(store, withdrawals)
  // A rebuilt burn whose block time could not be read carries the rebuild's clock, which is after
  // the deposit: the search's floor must come from the destination instead.
  const startedAtOf = (record: SavingsMoveRecord) =>
    withdrawals.find((w) => w.localId === record.withdrawalLocalId)?.startTimeEstimated
      ? undefined
      : record.startTime
  // A move stored before its factory was kept takes it from its burn's Sky meta.
  const withFactory = (record: SavingsMoveRecord): SavingsMoveRecord => {
    const factory =
      record.factory ??
      withdrawals.find((w) => w.localId === record.withdrawalLocalId)?.skyMove?.factory
    return factory && !record.factory ? { ...record, factory } : record
  }
  // Claimed before the vault's figures were kept: read them from the move's transaction, before any
  // claim. A move out's release is the tracker's hash, else found by the DAI paid to its escrow.
  if (deps.vault)
    for (const record of (await store.all()).filter(needsVaultFigures)) {
      stopIfAborted()
      const burn = withdrawals.find((w) => w.localId === record.withdrawalLocalId)
      const { move, error } = await backfillSavingsMoveFigures(
        withFactory(record),
        deps,
        startedAtOf(record),
        burn,
      ).catch((error: unknown) => ({ move: record, error }))
      const learned = {
        ...(move.deposit ? { deposit: move.deposit } : {}),
        ...(move.vault ? { vault: move.vault } : {}),
        ...(move.vaultUnknown ? { vaultUnknown: move.vaultUnknown } : {}),
        ...(move.vaultLookup !== undefined ? { vaultLookup: move.vaultLookup } : {}),
        ...(move.releaseScanFrom !== undefined ? { releaseScanFrom: move.releaseScanFrom } : {}),
        ...(move.runScanFrom !== undefined ? { runScanFrom: move.runScanFrom } : {}),
      }
      // Removed meanwhile (a cancelled move): not written back.
      await store.update(record.withdrawalLocalId, (current) => {
        if (!current) return null
        const changed = (Object.keys(learned) as (keyof typeof learned)[]).some(
          (key) => JSON.stringify(learned[key]) !== JSON.stringify(current[key]),
        )
        if (!changed && !error) return null
        return {
          ...current,
          ...learned,
          ...(error
            ? {
                lastCheck: {
                  at: now(),
                  message: `vault figures unreadable: ${claimRefusalMessage(error)}`,
                },
              }
            : {}),
        }
      })
    }
  for (const record of await store.all()) {
    if (!isSavingsMovePending(record)) continue
    stopIfAborted()
    const burn = withdrawals.find((w) => w.localId === record.withdrawalLocalId)
    const startedAt = startedAtOf(record)
    if (burn?.phase === "failed") continue
    let settled: Awaited<ReturnType<typeof settleSavingsMove>>
    try {
      settled = await settleSavingsMove(withFactory(record), deps, startedAt)
    } catch (error) {
      // A chain read that failed for this move: the others still settle.
      await store.update(record.withdrawalLocalId, (current) =>
        current
          ? {
              ...current,
              lastCheck: { at: now(), message: `search failed: ${claimRefusalMessage(error)}` },
            }
          : null,
      )
      continue
    }
    const { move, claimError, stored } = settled
    // When the claim resolved: a balance read that resolves after it holds the claim, and can land
    // before this queued write.
    const storedAt = now()
    if (claimError) onClaimError(record, claimError)
    // A claim another writer recorded meanwhile stands, and so does a better search range: neither
    // is written back. A move removed meanwhile stays removed.
    const saved = await store.update(record.withdrawalLocalId, (current) => {
      if (!current) return null
      const deposit = current.deposit?.claimed
        ? current.deposit
        : move.deposit && stored
        ? { ...move.deposit, storedAt }
        : move.deposit
      const range = scanRange(current, move)
      const lastCheck = {
        at: now(),
        message: deposit?.claimed
          ? "claimed"
          : claimError
          ? `claim refused: ${claimRefusalMessage(claimError)}`
          : deposit
          ? "deposit found, claim pending"
          : `no deposit on the destination portal yet, searched to block ${
              range.depositScanFrom ?? "0"
            }`,
      }
      return {
        ...current,
        ...move,
        ...(deposit ? { deposit } : {}),
        ...range,
        lastCheck,
        ...(deposit?.claimed ? { endTime: current.endTime ?? now() } : {}),
      }
    })
    if (saved && stored)
      await deps
        .refreshBalance?.()
        .catch((err: unknown) => logger.warn("[settleSavingsMoves] balance refresh failed:", err))
  }
}
