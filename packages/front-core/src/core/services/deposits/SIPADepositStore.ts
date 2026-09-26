/**
 * SIPADepositStore — storage for oxide SIPA deposit tracking, the only
 * deposit store since the legacy stealth stack was removed.
 *
 * Records are keyed by the counterfactual SIPA address. In the primary
 * third-party flow the record is created at `broadcast` — SIPA event discovery is
 * the recipient's first observable signal (`resolved`/`funded` are reachable
 * only in the self-initiated flow where this device is also the sender; the
 * receive screen is a passive share surface, not a phase renderer).
 *
 * Singleton + IStorageAdapter pattern over the RecordStorage kernel.
 */

import type { SIPADepositPhase } from "@obsidion/core/types"
import type { IStorageAdapter } from "../../storages/adapter"
import type { Address, Hash, Hex } from "viem"
import { RecordStorage } from "../bridge/RecordStorage"
import { getActiveNetworkId } from "../../activeNetworkId"

// Defined in the DTO leaf so sdk services share the vocabulary.
export type { SIPADepositPhase }

export type SipaOrigin = {
  sipaFactory: Address
  implementation: Address
  intentHash: Hex
  rollupVersion: string
  resweepable: boolean
} & (
  | { protocol: "legacy-eoa"; recoveryAddress: Address }
  | {
      protocol: "account"
      recoveryAccount: Address
      recoveryCommitment: Hex
      accountFactory: Address
    }
)

export interface SIPADepositRecord {
  /** Counterfactual SIPA address (canonical key, lowercased on store). */
  sipaAddress: Address
  /** The recipient's L2 account — the feed's group identity for SIPA deposits. */
  recipientL2Address: string
  /**
   * The SIPA event's `shared_secret_salt` (Fr hex). Everything else re-derives from it;
   * persisting it lets a claim resume across restarts. Device-local like the
   * rest of the store; it is half the recovery key (the other half is the
   * user's stealth scalar, which is never persisted).
   */
  messageSecret: string
  /** Derived recipient hash (Fr hex) the SIPA is bound to. */
  recipientHash: string
  /** Derived recovery address (the recoverERC20 signer identity). */
  recoveryAddress: string
  origin?: SipaOrigin
  /** L1 chain the SIPA lives on. */
  l1ChainId: number
  /** L2 network the record was created on (rollup L1 address). Unset only pre-boot. */
  networkId?: string
  /** Decimal display amount (gross before the sweep, net once known). */
  amount: string
  /** Token ticker for display. */
  tokenSymbol: string
  /** Current phase. */
  phase: SIPADepositPhase
  /** ms epoch when the record was created. */
  startTime: number
  /**
   * Created from a discovered SIPA event with no local record: history replayed onto this device rather
   * than an address it handed out. Such a record gets no fresh-broadcast scan window.
   */
  replayed?: boolean
  /** ms epoch when the record reached a terminal phase. */
  endTime?: number
  /** Incremented on each reorg demote; stale forward writes carry an older epoch. */
  reorgEpoch?: number
  /** The resolved name (self-initiated flow), e.g. "alice.oxidestaging.eth". */
  resolvedName?: string
  /** Set when the SIPA is a registration, not a plain deposit — the intent its address commits to. */
  intent?: "registration"
  /** L1 token address of the funding transfer. */
  tokenAddress?: Address
  /** Decimals of `tokenAddress` (6 for the mainnet USDC/USDT swap route, else 18). */
  tokenDecimals?: number
  /** Sweep log values — the claim inputs. Strings for JSON-safe bigints. */
  inboxIndex?: string
  /**
   * Inbox indexes already claimed off this SIPA. A re-used/topped-up SIPA is
   * re-swept (never re-broadcast), so later `Sweep` events surface only via
   * the known-SIPA scan and each claims independently — this is its dedup.
   */
  claimedInboxIndexes?: string[]
  /** Net amount forwarded to the portal (gross − fee), raw token units. */
  netAmount?: string
  /** Deductions between the gross and L2 credit, raw token units. */
  fee?: string
  /** Registration fee paid to the beneficiary, raw token units. */
  registrationFee?: string
  /** The portal's funding cut, raw token units: the part of `fee` the portal takes. */
  fpcFundingCut?: string
  /** L1 deploy-and-sweep tx hash. */
  sweepTxHash?: Hash
  /** L2 claim (store_deposit consumer) tx hash, once one exists. */
  claimTxHash?: string
  /** L1 recoverERC20/recoverETH tx hash. */
  recoveryTxHash?: Hash
  /** Error message when phase === "failed". */
  error?: string
  /**
   * L1 block height through which this SIPA's `Sweep` logs have been read (decimal
   * string, JSON-safe bigint). The next sync resumes just below it rather than
   * re-walking the whole look-back.
   */
  lastScannedBlock?: string
  /** ms epoch of the last `Sweep` scan — the slow lane's cadence check. */
  lastScanAt?: number
  /** Blocks (decimal strings) of sweeps a tick left unresolved; the next tick re-reads each one. */
  unresolvedSweepBlocks?: string[]
  /**
   * On-chain funding attribution, read from the token's `Transfer(to = sipa)`. The self-initiated
   * flow also stamps `fundingTxHash` from its own receipt, which lands first; the sender address is
   * only ever the log's.
   */
  fundingTxHash?: Hash
  fundingFromAddress?: Address
  /**
   * Sender-wallet display identity: the connected wallet on self-initiated
   * deposits, backfilled from `fundingFromAddress` on third-party ones once
   * the funding transfer is observed.
   */
  walletName?: string
  walletAddress?: string
  walletProvider?: string
  walletImageUrl?: string
}

const KEY_SIPA_DEPOSITS = "@obsidion/sipa-deposits/records"

type UpdatedListener = (record: SIPADepositRecord) => void
type ListChangedListener = (records: SIPADepositRecord[]) => void

/**
 * Phases with nothing left to observe: the deposit is credited (`claimed`),
 * abandoned (`failed`), or pulled back out on L1 (`recovered`). Stamps
 * `endTime`, and tells the sync loop this SIPA needs no per-tick log scan.
 */
const SETTLED_PHASES: ReadonlySet<SIPADepositPhase> = new Set(["claimed", "failed", "recovered"])

export function isSettledSipaPhase(phase: SIPADepositPhase): boolean {
  return SETTLED_PHASES.has(phase)
}

/**
 * A deposit address that was derived and broadcast but never paid. Opening Add funds publishes one
 * whether or not the visitor goes on to send anything, and discovery records it at `amount: "0"` —
 * publishing an address is not an incoming payment, so it must neither sit in the feed as "Pending"
 * nor spin under the bell. Any evidence that funds arrived (a nonzero amount, a sweep, an
 * advanced phase) shows the row.
 */
export function isUnfundedSipaDeposit(record: SIPADepositRecord): boolean {
  return (
    (record.phase === "broadcast" || record.phase === "resolved") &&
    Number(record.amount) === 0 &&
    !record.sweepTxHash &&
    !record.inboxIndex
  )
}

type SIPADepositPatch = Partial<SIPADepositRecord> & Pick<SIPADepositRecord, "phase">

/** The record a patch leaves, or null when the reorg-epoch guard refuses it. */
function merge(
  sipaAddress: Address,
  existing: SIPADepositRecord | null,
  patch: SIPADepositPatch,
  fallback?: Omit<SIPADepositRecord, "sipaAddress" | "phase">,
): SIPADepositRecord | null {
  let next: SIPADepositRecord
  if (existing) {
    // Reorg-epoch guard: a demoted record (epoch > 0) ignores forward writes
    // that don't carry the matching epoch.
    const epoch = existing.reorgEpoch ?? 0
    if (epoch > 0 && (patch.reorgEpoch ?? 0) !== epoch) return null
    next = { ...existing, ...patch, sipaAddress }
  } else {
    if (!fallback) {
      throw new Error(
        `SIPADepositStore.upsert: no existing record for ${sipaAddress} and no fallback supplied`,
      )
    }
    next = { ...fallback, ...patch, sipaAddress }
    next.networkId ??= getActiveNetworkId()
  }

  if (SETTLED_PHASES.has(next.phase) && !next.endTime) {
    next.endTime = Date.now()
  }
  return next
}

export class SIPADepositStore {
  private static instance: SIPADepositStore | null = null
  private store: RecordStorage<SIPADepositRecord>

  private constructor(storage: IStorageAdapter) {
    this.store = new RecordStorage<SIPADepositRecord>({
      storage,
      storageKey: KEY_SIPA_DEPOSITS,
      keyOf: (r) => r.sipaAddress.toLowerCase(),
      sortBy: (r) => r.startTime,
      label: "SIPADepositStore",
    })
  }

  static get(storage?: IStorageAdapter): SIPADepositStore {
    if (!SIPADepositStore.instance) {
      if (!storage) {
        throw new Error("First call to SIPADepositStore.get() requires a storage adapter")
      }
      SIPADepositStore.instance = new SIPADepositStore(storage)
    }
    return SIPADepositStore.instance
  }

  async load(): Promise<void> {
    return this.store.load()
  }

  get(sipaAddress: Address): SIPADepositRecord | null {
    return this.store.getByKey(sipaAddress.toLowerCase())
  }

  list(): SIPADepositRecord[] {
    return this.store.list()
  }

  /**
   * Insert or merge a record. Partial updates are shallow-merged onto the
   * existing record; sets endTime automatically when transitioning into a
   * terminal phase.
   */
  async upsert(
    sipaAddress: Address,
    patch: SIPADepositPatch,
    fallback?: Omit<SIPADepositRecord, "sipaAddress" | "phase">,
  ): Promise<SIPADepositRecord> {
    const stored = await this.store.updateRecord(sipaAddress.toLowerCase(), (existing) =>
      merge(sipaAddress, existing, patch, fallback),
    )
    return stored as SIPADepositRecord
  }

  /**
   * Merge a patch worked out from the record as it stands at the write, so a check on the record
   * and the write it decides cannot straddle another writer. `patch` returns null to write nothing;
   * a missing record is left missing.
   */
  async update(
    sipaAddress: Address,
    patch: (current: SIPADepositRecord) => SIPADepositPatch | null,
  ): Promise<SIPADepositRecord | null> {
    return this.store.updateRecord(sipaAddress.toLowerCase(), (existing) => {
      const next = existing && patch(existing)
      return next ? merge(existing.sipaAddress, existing, next) : null
    })
  }

  /**
   * Reorg demote. Only `claimed` is demotable — it is the sole phase advanced
   * by an L2 tx (the store_unclaimed_deposit claim); every other phase is
   * L1-derived (funding/funded/sweeping/pendingClaim/recoverable/recovered) or
   * has no upstream (broadcast) and refuses (returned unchanged). Clears
   * `endTime`, bumps `reorgEpoch`, keeps `claimTxHash` as the re-check anchor.
   * Returns null when no record exists.
   */
  async demote(sipaAddress: Address, toPhase: SIPADepositPhase): Promise<SIPADepositRecord | null> {
    return this.store.updateRecord(sipaAddress.toLowerCase(), (existing) => {
      if (!existing || existing.phase !== "claimed" || SETTLED_PHASES.has(toPhase)) return null
      return {
        ...existing,
        phase: toPhase,
        endTime: undefined,
        reorgEpoch: (existing.reorgEpoch ?? 0) + 1,
        // The reorged-out claim is the record's latest (`inboxIndex`); drop it
        // from the dedup set so the next scan re-attempts the claim.
        claimedInboxIndexes: existing.claimedInboxIndexes?.filter((i) => i !== existing.inboxIndex),
      }
    })
  }

  async remove(sipaAddress: Address): Promise<void> {
    await this.store.removeByKey(sipaAddress.toLowerCase())
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
