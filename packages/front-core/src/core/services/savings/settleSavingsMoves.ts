import {
  backfillSavingsMoveFigures,
  isSavingsMovePending,
  needsVaultFigures,
  savingsMoveOfWithdrawal,
  settleSavingsMove,
  type SavingsMoveSettleDeps,
} from "../../../oxide/savingsMoves"
import type { WithdrawalRecord } from "../bridge/types"
import type { SavingsMoveStorage } from "./SavingsMoveStorage"
import type { SavingsMoveRecord } from "./types"

/** Burns with Sky meta the store does not know: a rescan rebuilt them, or a reload cut the move short. */
async function adoptSavingsMoves(
  store: SavingsMoveStorage,
  withdrawals: WithdrawalRecord[],
): Promise<SavingsMoveRecord[]> {
  const adopted: SavingsMoveRecord[] = []
  for (const record of withdrawals) {
    if (record.phase === "failed" || store.get(record.localId)) continue
    const move = savingsMoveOfWithdrawal(record)
    if (!move) continue
    adopted.push(await store.put({ ...move, startTime: record.startTime }))
  }
  return adopted
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
  /** What a quote-less move should land; see `expectedSavingsNet`. */
  expectedNet?: (move: SavingsMoveRecord, burn: WithdrawalRecord) => Promise<bigint>
}

/** The pass running on each store, so a caller during a pass joins it. */
const passes = new WeakMap<SavingsMoveStorage, Promise<void>>()

/**
 * One pass over every pending move: adopt the ones only the burn records know, then find and claim
 * each one's deposit. A burn that failed is left alone; it funded nothing. Each pass leaves what it
 * found on the record, so a row can say why the move still waits. One pass runs per store at a time.
 */
export function settleSavingsMoves(
  store: SavingsMoveStorage,
  deps: SavingsSettlePassDeps,
  withdrawals: WithdrawalRecord[] = [],
  /** A found deposit the claim refused; the next pass tries again. */
  onClaimError: (move: SavingsMoveRecord, error: unknown) => void = () => {},
  now: () => number = Date.now,
): Promise<void> {
  const running = passes.get(store)
  if (running) return running
  const pass = settlePass(store, deps, withdrawals, onClaimError, now).finally(() =>
    passes.delete(store),
  )
  passes.set(store, pass)
  return pass
}

async function settlePass(
  store: SavingsMoveStorage,
  deps: SavingsSettlePassDeps,
  withdrawals: WithdrawalRecord[],
  onClaimError: (move: SavingsMoveRecord, error: unknown) => void,
  now: () => number,
): Promise<void> {
  await store.load()
  await adoptSavingsMoves(store, withdrawals)
  // A move adopted from a rescan has no quote: what it should land is priced from its burn. A read
  // that fails is tried again next pass.
  if (deps.expectedNet)
    for (const record of store.list()) {
      const priced = record.net !== undefined || record.expectedNet !== undefined
      if (priced || record.deposit || !isSavingsMovePending(record)) continue
      const burn = withdrawals.find((w) => w.localId === record.withdrawalLocalId)
      if (!burn?.skyMove || burn.phase === "failed") continue
      const expectedNet = await deps.expectedNet(record, burn).catch(() => undefined)
      const current = store.get(record.withdrawalLocalId)
      if (expectedNet !== undefined && current)
        await store.put({ ...current, expectedNet: expectedNet.toString() })
    }
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
    for (const record of store.list().filter(needsVaultFigures)) {
      const burn = withdrawals.find((w) => w.localId === record.withdrawalLocalId)
      const { move, error } = await backfillSavingsMoveFigures(
        withFactory(record),
        deps,
        startedAtOf(record),
        burn,
      ).catch((error: unknown) => ({ move: record, error }))
      // Removed meanwhile (a cancelled move): not written back.
      const current = store.get(record.withdrawalLocalId)
      if (!current) continue
      const learned = {
        ...(move.deposit ? { deposit: move.deposit } : {}),
        ...(move.vault ? { vault: move.vault } : {}),
        ...(move.vaultUnknown ? { vaultUnknown: move.vaultUnknown } : {}),
        ...(move.vaultLookup !== undefined ? { vaultLookup: move.vaultLookup } : {}),
        ...(move.releaseScanFrom !== undefined ? { releaseScanFrom: move.releaseScanFrom } : {}),
        ...(move.runScanFrom !== undefined ? { runScanFrom: move.runScanFrom } : {}),
      }
      const changed = (Object.keys(learned) as (keyof typeof learned)[]).some(
        (key) => JSON.stringify(learned[key]) !== JSON.stringify(current[key]),
      )
      if (changed || error)
        await store.put({
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
        })
    }
  for (const record of store.list()) {
    if (!isSavingsMovePending(record)) continue
    const burn = withdrawals.find((w) => w.localId === record.withdrawalLocalId)
    const startedAt = startedAtOf(record)
    if (burn?.phase === "failed") continue
    let settled: Awaited<ReturnType<typeof settleSavingsMove>>
    try {
      settled = await settleSavingsMove(withFactory(record), deps, startedAt)
    } catch (error) {
      // A chain read that failed for this move: the others still settle.
      const current = store.get(record.withdrawalLocalId)
      if (current)
        await store.put({
          ...current,
          lastCheck: { at: now(), message: `search failed: ${claimRefusalMessage(error)}` },
        })
      continue
    }
    const { move, claimError } = settled
    if (claimError) onClaimError(record, claimError)
    // A claim another writer recorded meanwhile stands, and so does a better search range: neither
    // is written back. A move removed meanwhile stays removed.
    const current = store.get(record.withdrawalLocalId)
    if (!current) continue
    const deposit = current.deposit?.claimed ? current.deposit : move.deposit
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
    await store.put({
      ...current,
      ...move,
      ...(deposit ? { deposit } : {}),
      ...range,
      lastCheck,
      ...(deposit?.claimed ? { endTime: current.endTime ?? now() } : {}),
    })
  }
}
