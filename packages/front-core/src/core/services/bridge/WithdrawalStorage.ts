/**
 * WithdrawalStorage — On-device tracking for L2→L1 withdrawals.
 *
 * Singleton backed by the shared RecordStorage kernel, persisted as a single
 * JSON blob under one storage key, per-record and list-changed listeners,
 * newest-first listing.
 *
 * Keying lifecycle — withdrawals are always keyed by `localId`, generated when
 * the user taps Confirm. `l2TxHash` is stored on the record once the L2 burn is
 * mined and is used as a secondary lookup for the chain-watching tracker.
 *
 * The activity tab / linked-wallet detail merge withdrawals with SIPA deposits
 * via ActivityFeed.
 */

import type { IStorageAdapter } from "../../storages/adapter"
import { isHash } from "viem"
import {
  WITHDRAWAL_TERMINAL_PHASES,
  type WithdrawalPhase,
  type WithdrawalRecord,
} from "./types"
import { RecordStorage } from "./RecordStorage"
import { getActiveNetworkId } from "../../activeNetworkId"


const KEY_WITHDRAWALS = "@obsidion/withdrawals/records"

/** Fresh `wdraw_*` key for a record created at Confirm — the prefix is this store's keying contract. */
export function newWithdrawalLocalId(): string {
  return `wdraw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

type UpdatedListener = (record: WithdrawalRecord) => void
type ListChangedListener = (records: WithdrawalRecord[]) => void

function keyForRecord(record: WithdrawalRecord): string {
  return record.localId.toLowerCase()
}

const PHASE_RANK: Record<WithdrawalPhase, number> = {
  submitting: 0,
  l2_mined: 1,
  awaiting_proven: 2,
  finalizing_l1: 3,
  swapping: 4,
  recoverable: 5,
  failed: 6,
  recovered: 7,
  done: 8,
}

/** Phases reached only by observing the L1 release; nothing local outranks or unwinds them. */
const RELEASED_PHASES: ReadonlySet<WithdrawalPhase> = new Set<WithdrawalPhase>([
  "swapping",
  "recoverable",
  "recovered",
  "done",
])

function mergeWithdrawalRecords(
  existing: WithdrawalRecord,
  incoming: WithdrawalRecord,
): WithdrawalRecord {
  const phase =
    PHASE_RANK[incoming.phase] >= PHASE_RANK[existing.phase] ? incoming.phase : existing.phase

  return {
    ...existing,
    ...incoming,
    localId: existing.localId,
    phase,
    l2TxHash: incoming.l2TxHash ?? existing.l2TxHash,
    blockNumber: incoming.blockNumber ?? existing.blockNumber,
    rawAmount: incoming.rawAmount ?? existing.rawAmount,
    relayerTip: incoming.relayerTip ?? existing.relayerTip,
    fpcFundingCut: incoming.fpcFundingCut ?? existing.fpcFundingCut,
    withdrawalId: incoming.withdrawalId ?? existing.withdrawalId,
    l1TxHash: incoming.l1TxHash ?? existing.l1TxHash,
    finalizeTxHash: incoming.finalizeTxHash ?? existing.finalizeTxHash,
    error: incoming.error ?? existing.error,
    endTime:
      existing.endTime != null && incoming.endTime != null
        ? Math.max(existing.endTime, incoming.endTime)
        : incoming.endTime ?? existing.endTime,
    phaseEnteredAt: incoming.phaseEnteredAt ?? existing.phaseEnteredAt,
  }
}

/** Longest a pre-mine `submitting` row may sit before it counts as interrupted; proving takes minutes. */
export const WITHDRAWAL_SUBMIT_TIMEOUT_MS = 10 * 60 * 1000

export class WithdrawalStorage {
  private static instance: WithdrawalStorage | null = null
  private store: RecordStorage<WithdrawalRecord>
  /** Secondary index: lowercased l2TxHash → record localId. */
  private l2TxHashIndex = new Map<string, string>()

  private constructor(storage: IStorageAdapter) {
    this.store = new RecordStorage<WithdrawalRecord>({
      storage,
      storageKey: KEY_WITHDRAWALS,
      keyOf: keyForRecord,
      sortBy: (r) => r.startTime,
      label: "WithdrawalStorage",
    })
  }

  static get(storage?: IStorageAdapter): WithdrawalStorage {
    if (!WithdrawalStorage.instance) {
      if (!storage) {
        throw new Error("First call to WithdrawalStorage.get() requires a storage adapter")
      }
      WithdrawalStorage.instance = new WithdrawalStorage(storage)
    }
    return WithdrawalStorage.instance
  }

  async load(): Promise<void> {
    await this.store.load()
    await this.store.normalizeKeys(mergeWithdrawalRecords)
    this.rebuildL2TxHashIndex()
  }

  // ============================================================================
  // Reads
  // ============================================================================

  /** Get by stable localId, or by l2TxHash for compatibility with tracker/UI handles. */
  get(keyOrHash: string): WithdrawalRecord | null {
    const key = keyOrHash.toLowerCase()
    return this.store.getByKey(key) ?? this.findByL2TxHash(key)
  }

  /** Convenience: look up by l2TxHash specifically (used by the tracker). */
  getByL2TxHash(l2TxHash: string): WithdrawalRecord | null {
    return this.findByL2TxHash(l2TxHash.toLowerCase())
  }

  list(): WithdrawalRecord[] {
    return this.store.list()
  }

  // ============================================================================
  // Writes
  // ============================================================================

  /**
   * Create a fresh record (pre-mine). Caller supplies a full record including
   * the generated `localId`, which remains the stable persistence key.
   */
  async create(record: WithdrawalRecord): Promise<WithdrawalRecord> {
    await this.load()
    const stamped = this.stampTerminal({
      ...record,
      networkId: record.networkId ?? getActiveNetworkId(),
    })
    const stored = await this.store.setRecord(keyForRecord(stamped), stamped)
    this.indexAddIfPresent(stored)
    return stored
  }

  /**
   * Fail `submitting` rows older than `maxAgeMs`. Proving and signing live only in the tab that
   * started them, so a pre-mine row that old was interrupted before its burn was sent. Returns the
   * rows failed.
   */
  async failInterruptedSubmissions(
    now: number = Date.now(),
    maxAgeMs: number = WITHDRAWAL_SUBMIT_TIMEOUT_MS,
  ): Promise<WithdrawalRecord[]> {
    await this.load()
    const failed: WithdrawalRecord[] = []
    for (const record of this.store.list()) {
      if (record.phase !== "submitting" || record.l2TxHash) continue
      if (now - record.startTime < maxAgeMs) continue
      failed.push(
        await this.patch(record.localId, {
          phase: "failed",
          error:
            "This withdrawal was interrupted before it finished. The amount is still in your balance.",
          reorgEpoch: record.reorgEpoch,
        }),
      )
    }
    return failed
  }

  /**
   * Patch an existing record by stable `localId` or secondary `l2TxHash`.
   * Unknown key throws. Reorg-epoch guard: once a record has been demoted
   * (`reorgEpoch > 0`), a patch not carrying the matching `reorgEpoch` is a
   * stale forward write and no-ops (returns the record unchanged).
   */
  async patch(
    currentKey: string,
    patch: Partial<WithdrawalRecord> & Pick<WithdrawalRecord, "phase">,
    /** Reject when the write does not persist, instead of warning. */
    opts?: { strict?: boolean },
  ): Promise<WithdrawalRecord> {
    await this.load()
    const existing = this.get(currentKey)
    if (!existing) {
      throw new Error(`WithdrawalStorage.patch: no record for key ${currentKey}`)
    }
    let previousHash: string | undefined
    const stored = await this.store.updateRecord(
      keyForRecord(existing),
      (current) => {
        const base = current ?? existing
        previousHash = base.l2TxHash
        const epoch = base.reorgEpoch ?? 0
        if (epoch > 0 && (patch.reorgEpoch ?? 0) !== epoch) return null
        return this.stampTerminal({ ...base, ...patch, localId: base.localId })
      },
      opts,
    )
    if (stored) this.indexReplace(previousHash, stored)
    return stored ?? existing
  }

  /**
   * Persist the mined L2 burn data while keeping the record keyed by localId.
   *
   * `relayerTip` is the tip the burn offered, in raw token units. It is the deduction only the
   * burn knows; the portal's `fpcFundingCut` sits on the record from creation. A caller that does
   * not know the tip leaves it out and the record carries no breakdown.
   */
  async markMined(
    localId: string,
    l2TxHash: string,
    blockNumber: number,
    rawAmount: string,
    relayerTip?: string,
  ): Promise<WithdrawalRecord> {
    // Fail fast on a malformed hash — silently storing a non-0x / non-hex
    // string would trip the tx-effect / receipt lookups later under the guise
    // of "burn not found" and mask the real root cause.
    if (!isHash(l2TxHash)) {
      throw new Error(
        `WithdrawalStorage.markMined: l2TxHash is not a valid 32-byte hex hash (${l2TxHash})`,
      )
    }
    await this.load()
    let previousHash: string | undefined
    const stored = await this.store.updateRecord(localId.toLowerCase(), (existing) => {
      if (!existing) {
        throw new Error(`WithdrawalStorage.markMined: no record for localId ${localId}`)
      }
      previousHash = existing.l2TxHash
      return {
        ...existing,
        l2TxHash,
        blockNumber,
        rawAmount,
        relayerTip: relayerTip ?? existing.relayerTip,
        phase: "l2_mined",
      }
    })
    this.indexReplace(previousHash, stored!)
    return stored!
  }

  /**
   * Reorg demote. Re-enters the prior phase (`finalizing_l1 → awaiting_proven`,
   * `awaiting_proven → l2_mined`; `l2_mined` stays put — it is the earliest
   * post-mine phase and the receipt poll re-verifies it), clears `endTime`, and
   * bumps `reorgEpoch` so stale forward patches are fenced. `droppedBurn: true`
   * is the reorg exception to never-fails-post-mine: the burn dropped, the
   * record lands `failed` terminally. Refuses every released phase (L1-derived),
   * `failed`, and pre-mine `submitting` — returns the record unchanged.
   *
   * `finalizeTxHash` is dropped: it names a release of the very burn the reorg invalidated, so
   * showing it would link the row to a transaction that no longer settles it. Offering the manual
   * finalize again once the burn re-proves is safe — a duplicate submission reverts harmlessly.
   */
  async demote(keyOrHash: string, opts: { droppedBurn?: boolean } = {}): Promise<WithdrawalRecord> {
    await this.load()
    const found = this.get(keyOrHash)
    if (!found) {
      throw new Error(`WithdrawalStorage.demote: no record for key ${keyOrHash}`)
    }
    let previousHash: string | undefined
    const stored = await this.store.updateRecord(keyForRecord(found), (current) => {
      const existing = current ?? found
      previousHash = existing.l2TxHash
      if (
        RELEASED_PHASES.has(existing.phase) ||
        existing.phase === "failed" ||
        existing.phase === "submitting"
      ) {
        return null
      }
      const reorgEpoch = (existing.reorgEpoch ?? 0) + 1
      return opts.droppedBurn
        ? {
            ...existing,
            phase: "failed",
            reorgEpoch,
            endTime: Date.now(),
            droppedBurn: true,
            error: "Withdrawal transaction dropped in a reorg",
            finalizeTxHash: undefined,
          }
        : {
            ...existing,
            phase: existing.phase === "finalizing_l1" ? "awaiting_proven" : "l2_mined",
            reorgEpoch,
            endTime: undefined,
            phaseEnteredAt: Date.now(),
            finalizeTxHash: undefined,
          }
    })
    if (!stored) return found
    this.indexReplace(previousHash, stored)
    return stored
  }

  async remove(currentKey: string): Promise<void> {
    await this.load()
    const existing = this.get(currentKey)
    if (existing) this.indexRemove(existing.l2TxHash)
    await this.store.removeByKey(existing ? keyForRecord(existing) : currentKey.toLowerCase())
  }

  async clearAll(): Promise<void> {
    this.l2TxHashIndex.clear()
    await this.store.clearAll()
  }

  // ============================================================================
  // Subscriptions
  // ============================================================================

  onUpdated(listener: UpdatedListener): () => void {
    return this.store.onUpdated(listener)
  }

  onListChanged(listener: ListChangedListener): () => void {
    return this.store.onListChanged(listener)
  }

  // ============================================================================
  // Internal
  // ============================================================================

  /**
   * Auto-stamp `endTime` on terminal-phase transitions. Idempotent: preserves
   * a pre-existing `endTime` so the first terminal-entry timestamp sticks.
   */
  private stampTerminal(record: WithdrawalRecord): WithdrawalRecord {
    if (WITHDRAWAL_TERMINAL_PHASES.has(record.phase as WithdrawalPhase) && !record.endTime) {
      return { ...record, endTime: Date.now() }
    }
    return record
  }

  private findByL2TxHash(l2TxHash: string): WithdrawalRecord | null {
    const localId = this.l2TxHashIndex.get(l2TxHash.toLowerCase())
    if (!localId) return null
    return this.store.getByKey(localId) ?? null
  }

  // ---- Secondary-index maintenance --------------------------------------

  private rebuildL2TxHashIndex(): void {
    this.l2TxHashIndex.clear()
    for (const record of this.store.list()) {
      this.indexAddIfPresent(record)
    }
  }

  private indexAddIfPresent(record: WithdrawalRecord): void {
    if (record.l2TxHash) {
      this.l2TxHashIndex.set(record.l2TxHash.toLowerCase(), keyForRecord(record))
    }
  }

  private indexRemove(l2TxHash: string | undefined): void {
    if (l2TxHash) {
      this.l2TxHashIndex.delete(l2TxHash.toLowerCase())
    }
  }

  /**
   * Adjust the index when a record's l2TxHash may have changed (patch /
   * markMined). Removes the prior mapping if the hash changed, then adds the
   * new one if present.
   */
  private indexReplace(previousHash: string | undefined, next: WithdrawalRecord): void {
    const nextHash = next.l2TxHash?.toLowerCase()
    const prevHash = previousHash?.toLowerCase()
    if (prevHash && prevHash !== nextHash) {
      this.l2TxHashIndex.delete(prevHash)
    }
    this.indexAddIfPresent(next)
  }
}
