/**
 * Refundable-deposit enumeration for migration.
 *
 * The same-rollup path is chain/PXE-derived: synced `SIPA` events supply SIPA identities and
 * L1 `Sweep` + portal `Deposit` events supply refundable deposits. It requires no wallet records.
 * The record input remains as a compatibility surface for existing record-based callers.
 */
import type { SIPADepositPhase, SIPADepositRecord } from "./SIPADepositStore"

/** The minimum secret-bearing identity needed to find refundable value on L1. */
export interface RefundableSipaSource {
  sipaAddress: string
  recipientL2Address: string
  /** Fr hex. */
  messageSecret: string
  origin: "sipa-event" | "legacy-record"
  /** Used only by non-migration callers that deliberately retain local dedup policy. */
  claimedInboxIndexes?: readonly string[]
}

/** Plain-data form of one `SIPA` event synced from this rollup's token. */
export interface RefundableSipaEvent {
  /** The event's `shared_secret_salt`, as Fr hex. */
  messageSecret: string
  resweepable: boolean
}

/** L1 readers pre-bound to the relevant portal and, for migration, an explicit scan range. */
export interface RefundDepositL1Reads<TFr> {
  readSweepEvents(
    sipaAddress: string,
  ): Promise<ReadonlyArray<{ index: bigint; amount: bigint; txHash: string; blockNumber?: bigint }>>
  readDepositMessageKey(sweepTxHash: string, inboxIndex: bigint): Promise<TFr | null>
}

export interface RefundableDeposit<TFr> {
  sipaAddress: string
  l2Recipient: string
  messageSecret: string
  messageKey: TFr
  messageLeafIndex: bigint
  amount: bigint
  sweepBlockNumber?: bigint
}

/** A broadcast SIPA that still holds L1 funds and has not yet been fully swept. */
export interface InTransitSipaDeposit {
  source: RefundableSipaSource
  balance: bigint
}

export interface RefundableDepositScan<TFr> {
  refundable: RefundableDeposit<TFr>[]
  inTransit: InTransitSipaDeposit[]
}

/** Legacy phase policy retained for record-based callers. */
export function isSweptDepositRecord(record: SIPADepositRecord): boolean {
  const phase: SIPADepositPhase = record.phase
  if (phase === "pendingClaim" || phase === "claimed") return true
  return phase === "sweeping" && !!record.sweepTxHash
}

function legacySources(args: {
  records: readonly SIPADepositRecord[]
  recipientL2Address: string
  includeLocallyClaimed?: boolean
}): RefundableSipaSource[] {
  const recipient = args.recipientL2Address.toLowerCase()
  return args.records
    .filter(
      (record) =>
        record.recipientL2Address.toLowerCase() === recipient &&
        !!record.messageSecret &&
        (args.includeLocallyClaimed || isSweptDepositRecord(record)),
    )
    .map((record) => ({
      sipaAddress: record.sipaAddress,
      recipientL2Address: record.recipientL2Address,
      messageSecret: record.messageSecret,
      origin: "legacy-record" as const,
      claimedInboxIndexes: args.includeLocallyClaimed ? [] : record.claimedInboxIndexes,
    }))
}

/**
 * Enumerate at `(SIPA identity × Sweep index)` granularity. Supplying `sources` is the same-rollup
 * migration path and never reads wallet storage: event-derived identities plus L1 events decide the
 * result. The `records` form preserves existing caller behavior.
 */
export async function enumerateRefundableDeposits<TFr>(args: {
  sources?: readonly RefundableSipaSource[]
  records?: readonly SIPADepositRecord[]
  l1Reads: RefundDepositL1Reads<TFr>
  recipientL2Address?: string
  includeLocallyClaimed?: boolean
  readErrorsThrow?: boolean
  onUnreadableMessageKey?: (sipaAddress: string) => void
  /** Same-rollup chain check; true drops a sweep already consumed on L2. */
  isClaimed?: (deposit: RefundableDeposit<TFr>) => Promise<boolean>
}): Promise<RefundableDeposit<TFr>[]> {
  return (await scanRefundableDeposits(args)).refundable
}

/**
 * Chain-only same-rollup scan. Besides swept/unclaimed deposits, reports broadcast SIPAs whose L1
 * token balance is still non-zero (funded/finalized but not yet fully swept). `readSipaBalance` and
 * `isClaimed` are injected so the caller can bind the retiring deployment's token and L2 node.
 */
export async function scanRefundableDeposits<TFr>(args: {
  sources?: readonly RefundableSipaSource[]
  records?: readonly SIPADepositRecord[]
  l1Reads: RefundDepositL1Reads<TFr>
  recipientL2Address?: string
  includeLocallyClaimed?: boolean
  readErrorsThrow?: boolean
  onUnreadableMessageKey?: (sipaAddress: string) => void
  readSipaBalance?: (sipaAddress: string) => Promise<bigint>
  isClaimed?: (deposit: RefundableDeposit<TFr>) => Promise<boolean>
}): Promise<RefundableDepositScan<TFr>> {
  const sources =
    args.sources ??
    legacySources({
      records: args.records ?? [],
      recipientL2Address: args.recipientL2Address ?? "",
      includeLocallyClaimed: args.includeLocallyClaimed,
    })
  const out: RefundableDeposit<TFr>[] = []
  const inTransit: InTransitSipaDeposit[] = []

  for (const source of sources) {
    if (args.readSipaBalance) {
      try {
        const balance = await args.readSipaBalance(source.sipaAddress)
        if (balance > 0n) inTransit.push({ source, balance })
      } catch (err) {
        if (args.readErrorsThrow) throw err
      }
    }
    let sweeps: Awaited<ReturnType<RefundDepositL1Reads<TFr>["readSweepEvents"]>>
    try {
      sweeps = await args.l1Reads.readSweepEvents(source.sipaAddress)
    } catch (err) {
      if (args.readErrorsThrow) throw err
      continue
    }
    const claimed = new Set(source.claimedInboxIndexes ?? [])
    for (const sweep of sweeps) {
      if (claimed.has(sweep.index.toString())) continue
      let messageKey: TFr | null
      try {
        messageKey = await args.l1Reads.readDepositMessageKey(sweep.txHash, sweep.index)
      } catch (err) {
        if (args.readErrorsThrow) throw err
        continue
      }
      if (messageKey === null) {
        args.onUnreadableMessageKey?.(source.sipaAddress)
        continue
      }
      const deposit: RefundableDeposit<TFr> = {
        sipaAddress: source.sipaAddress,
        l2Recipient: source.recipientL2Address,
        messageSecret: source.messageSecret,
        messageKey,
        messageLeafIndex: sweep.index,
        amount: sweep.amount,
        sweepBlockNumber: sweep.blockNumber,
      }
      try {
        if (args.isClaimed && (await args.isClaimed(deposit))) continue
      } catch (err) {
        if (args.readErrorsThrow) throw err
        continue
      }
      out.push(deposit)
    }
  }
  return { refundable: out, inTransit }
}
