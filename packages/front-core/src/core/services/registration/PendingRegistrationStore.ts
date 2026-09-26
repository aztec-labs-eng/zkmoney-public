/**
 * PendingRegistrationStore — the persisted state machine behind deposit-gated tag registration
 * (registration-fee.md: registration by deposit).
 *
 * One record per predicted L1 account, created before the deposit address is shown and closed when
 * the Registry confirms the name (or the name is lost). Custody is "the L1 deposit landed and was
 * swept", not a bundler receipt: the record tracks the registration SIPA the sender funds and the
 * deposit/sweep bookmarks, and a relayer (or the self-custody router) does the on-chain sweep.
 *
 * The record holds NO bearer material: the NameClaim, the consent signature, and the signed terms are
 * never persisted — they are re-derivable (consentSig, deterministic in the master secret) or
 * re-requestable (the NameClaim, re-issued by the claim server), so the record stays valid in plain
 * (unencrypted) storage on every platform. Writes are strict: a failed adapter write rejects the
 * mutation so the machine never proceeds believing a bookmark is durable when it is not.
 *
 * Singleton + IStorageAdapter pattern over the RecordStorage kernel (mirrors SIPADepositStore).
 */

import type { Hex } from "viem"

import type { IStorageAdapter } from "../../storages/adapter"
import { RecordStorage } from "../bridge/RecordStorage"

export type PendingRegistrationPhase =
  | "awaiting_deposit" // SIPA derived + NameClaim obtained + broadcast; waiting for the sender's L1 deposit
  | "funded" // a deposit at/above the registration floor was seen at the SIPA; waiting for the relayer sweep
  | "confirmed" // Registry resolves the name to our account. Terminal.
  | "failed_taken" // name race lost to another claimant. Terminal.
  | "failed_terminal" // abandoned, or a terminal failure. Terminal.

/** UI projection of the record: what the badge surfaces render. */
export type RegistrationUiState = "none" | "pending" | "escalated" | "failed"

/** The public P-256 key the original session included — pinned by value so a resumed rebuild is identical. */
export interface PendingRegistrationR1Key {
  qx: Hex
  qy: Hex
}

export interface PendingRegistrationRecord {
  /** Predicted L1 OxideAccount (the record's `owner`; canonical key, lowercased on store). */
  account: string
  /** Bare tag ("alice"). */
  tag: string
  /** Wire nameHash the Registry keys on. */
  nameHash: Hex
  /** The L2 address recorded as UserRecord.l2Address — pinned so a resumed rebuild is identical. */
  l2Address: Hex
  /** Present when the batch installs an r1 key; its qx/qy is also the confirmation match target. */
  r1Key?: PendingRegistrationR1Key
  /** The passkey credential id (base64url) the install records as the r1 key's metadata — pinned so a
   *  resumed rebuild is identical. */
  credentialId?: string
  /** Chain the session started on; a tick under a different chain no-ops. */
  l1ChainId: number

  // ── registration SIPA custody ──────────────────────────────────────────
  /** The registration SIPA a sender funds — the deposit address whose sweep registers the name. */
  sipaAddress: string
  /** The exact fee (base units, decimal string) and the allowlisted funder the SIPA address commits
   *  to; the sweep pays exactly these. Absent only on records written before the intent committed
   *  its payment: those cannot re-derive their address, and the resume treats them as a moved
   *  derivation. */
  fee?: string
  beneficiary?: Hex
  /** The fee token the deposit must be paid in (`RegistrationController.FEE_TOKEN`). */
  depositToken: Hex
  /** Whether the initial broadcast to relayers landed (the SIPA is discoverable). */
  broadcast: boolean
  /** ms epoch of the last broadcast. Paces the re-broadcast nudge: without it a funded record that
   *  never gets swept re-broadcasts on every poll, each one a client proof. */
  lastBroadcastAt?: number
  /** ms epoch a session began proving a broadcast that has not landed. A tick inside the in-flight
   *  window leaves the record to that session instead of proving again. */
  broadcastStartedAt?: number
  /** ms epoch a funding transfer at/above the floor was first seen at the SIPA. */
  fundedAt?: number
  /** The L1 transfer that funded the SIPA (self-initiated deposits only; a third-party's is invisible). */
  fundingTxHash?: Hex
  /** ms epoch the registration sweep was observed (a `Sweep` event on the SIPA). */
  sweptAt?: number
  /** The deploy-and-sweep tx that registered the name. */
  sweepTxHash?: Hex
  /** The recovered deposit that bought wallet entry: on the refunded record once its funded stamp
   *  is gone, and on the addresses that replaced it. */
  refundedEntry?: { sipaAddress: string; recoveryTxHash: Hex; amount: string }
  /** The address this one replaced. `refunded`: its deposit was recovered first. `broadcastSpent`:
   *  it, or one before it, used the account's one-shot broadcast, so only a manual sweep registers
   *  this address and the tick never re-broadcasts it. */
  replaced?: { sipaAddress: string; refunded: boolean; broadcastSpent: boolean }

  phase: PendingRegistrationPhase
  /** ms epoch before which resume must not re-run mutating calls (server Retry-After / backoff floor). */
  nextAttemptAt?: number
  /** Armed re-broadcast cycles — incremented only once sign-deps are in hand, right before signDomain. */
  retries: number
  /** ms epoch when the session created the record. */
  startTime: number
  /** ms epoch when the record reached a terminal phase. */
  endTime?: number
}

export const PENDING_REGISTRATION_STORAGE_KEY = "@obsidion/pending-registration/records"

/** Silent re-broadcasts stop being silent past either bound; detection continues. */
export const ESCALATION_MAX_RETRIES = 3
export const ESCALATION_MAX_AGE_MS = 48 * 60 * 60 * 1000

const TERMINAL_PHASES: ReadonlySet<PendingRegistrationPhase> = new Set([
  "confirmed",
  "failed_taken",
  "failed_terminal",
])

export function isTerminalRegistrationPhase(phase: PendingRegistrationPhase): boolean {
  return TERMINAL_PHASES.has(phase)
}

/** Past either bound the machine stops silent re-broadcasting; the re-broadcast branch becomes manual-only. */
export function isRegistrationEscalated(
  record: Pick<PendingRegistrationRecord, "retries" | "startTime">,
  nowMs: number = Date.now(),
): boolean {
  return (
    record.retries >= ESCALATION_MAX_RETRIES || nowMs - record.startTime > ESCALATION_MAX_AGE_MS
  )
}

/** The badge state a record projects to; failure states persist until the user re-enters claiming. */
export function registrationUiState(
  record: PendingRegistrationRecord | null,
  nowMs: number = Date.now(),
): RegistrationUiState {
  if (!record) return "none"
  if (record.phase === "confirmed") return "none"
  if (record.phase === "failed_taken" || record.phase === "failed_terminal") return "failed"
  if (isRegistrationEscalated(record, nowMs)) return "escalated"
  return "pending"
}

function matchesWallet(record: PendingRegistrationRecord, l2Address?: string): boolean {
  return l2Address === undefined || record.l2Address.toLowerCase() === l2Address.toLowerCase()
}

type UpdatedListener = (record: PendingRegistrationRecord) => void
type ListChangedListener = (records: PendingRegistrationRecord[]) => void

/**
 * Storage can hold records written against the retired 4337 schema (NameClaim + userOp/receipt
 * bookmarks). Terminal records are never pruned and `upsert` spreads the stored object, so those
 * dead keys are dropped as a record comes off storage.
 */
function stripLegacyKeys(record: PendingRegistrationRecord): PendingRegistrationRecord {
  const {
    claim,
    beneficiaryId,
    l2SetupComplete,
    attempt,
    userOpHash,
    receiptConfirmedAt,
    receiptFailedHash,
    submittedAt,
    ...rest
  } = record as PendingRegistrationRecord & Record<string, unknown>
  return rest as PendingRegistrationRecord
}

export class PendingRegistrationStore {
  private static instance: PendingRegistrationStore | null = null
  private store: RecordStorage<PendingRegistrationRecord>

  private constructor(storage: IStorageAdapter) {
    this.store = new RecordStorage<PendingRegistrationRecord>({
      storage,
      storageKey: PENDING_REGISTRATION_STORAGE_KEY,
      keyOf: (r) => r.account.toLowerCase(),
      sortBy: (r) => r.startTime,
      label: "PendingRegistrationStore",
      strict: true,
      normalize: stripLegacyKeys,
    })
  }

  /** First call must pass a storage adapter; any IStorageAdapter works — the record holds no secrets. */
  static get(storage?: IStorageAdapter): PendingRegistrationStore {
    if (!PendingRegistrationStore.instance) {
      if (!storage) {
        throw new Error("First call to PendingRegistrationStore.get() requires a storage adapter")
      }
      PendingRegistrationStore.instance = new PendingRegistrationStore(storage)
    }
    return PendingRegistrationStore.instance
  }

  async load(): Promise<void> {
    return this.store.load()
  }

  /** Re-reads storage so records another tab wrote or closed are visible here. */
  async reload(): Promise<void> {
    return this.store.reload()
  }

  get(account: string): PendingRegistrationRecord | null {
    return this.store.getByKey(account.toLowerCase())
  }

  list(): PendingRegistrationRecord[] {
    return this.store.list()
  }

  /**
   * The most recent non-terminal record — the one the resume driver and badges act on.
   * `l2Address` scopes to one wallet: badge surfaces pass the active wallet so a record another
   * wallet on this device left in flight never pins their status.
   */
  current(l2Address?: string): PendingRegistrationRecord | null {
    // list() is newest-first (RecordStorage sorts by startTime descending), so [0] is the latest.
    return (
      this.store
        .list()
        .find((r) => !isTerminalRegistrationPhase(r.phase) && matchesWallet(r, l2Address)) ?? null
    )
  }

  /** The most recent record in a failed phase — surfaces the re-claim notice until acknowledged. */
  latestFailed(l2Address?: string): PendingRegistrationRecord | null {
    return (
      this.store
        .list()
        .find(
          (r) =>
            (r.phase === "failed_taken" || r.phase === "failed_terminal") &&
            matchesWallet(r, l2Address),
        ) ?? null
    )
  }

  async upsert(
    account: string,
    patch: Partial<PendingRegistrationRecord>,
    fallback?: Omit<PendingRegistrationRecord, "account">,
  ): Promise<PendingRegistrationRecord> {
    await this.store.load()
    const key = account.toLowerCase()
    const existing = this.store.getByKey(key)

    let next: PendingRegistrationRecord
    if (existing) {
      next = { ...existing, ...patch, account }
    } else {
      if (!fallback) {
        throw new Error(
          `PendingRegistrationStore.upsert: no existing record for ${account} and no fallback supplied`,
        )
      }
      next = { ...fallback, ...patch, account }
    }

    if (TERMINAL_PHASES.has(next.phase)) {
      if (!next.endTime) next.endTime = Date.now()
    }

    return this.store.setRecord(key, next)
  }

  async close(
    account: string,
    phase: PendingRegistrationPhase,
  ): Promise<PendingRegistrationRecord> {
    return this.upsert(account, { phase })
  }

  async remove(account: string): Promise<void> {
    await this.store.removeByKey(account.toLowerCase())
  }

  async clearAll(): Promise<void> {
    await this.store.clearAll()
  }

  onUpdated(listener: UpdatedListener): () => void {
    return this.store.onUpdated(listener)
  }

  onListChanged(listener: ListChangedListener): () => void {
    return this.store.onListChanged(listener)
  }
}
