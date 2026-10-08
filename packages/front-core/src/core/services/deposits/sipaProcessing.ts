/**
 * Why a funded deposit has not been swept yet. The reason is derived from a capacity read of the deposit's own portal
 * and sits beside the persisted phase; it never changes the record. A reading describes the current blocker only: it
 * does not say why an earlier sweep attempt failed, and it does not promise that a relayer will sweep the deposit
 * once capacity returns.
 */
import { isUnfundedSipaDeposit, type SIPADepositRecord } from "./SIPADepositStore"
import { isStuckSweep } from "./sipaStuck"

/** Settlement-token amounts in base units, with the decimals to show them. */
interface Observed {
  decimals: number
  /** Epoch ms the read started. */
  observedAt: number
}

export type SipaRefill =
  | { status: "none" }
  | { status: "unknown" }
  | { status: "estimate"; seconds: bigint }

export type SipaProcessingReason =
  /** Capacity is short now. `requiredAtomic` is absent when the credit is unknown and capacity is zero. */
  | ({
      kind: "capacity"
      requiredAtomic?: bigint
      availableAtomic: bigint
      refill: SipaRefill
    } & Observed)
  /** Larger than the portal's whole capacity. Refill cannot help. */
  | ({ kind: "ceiling"; requiredAtomic: bigint; ceilingAtomic: bigint } & Observed)
  /** Larger than one deposit may carry. Refill cannot help. */
  | { kind: "operation-cap"; observedAt: number }
  /** Capacity fits now and no sweep has been seen. */
  | ({ kind: "processing"; availableAtomic: bigint } & Observed)
  /** The first read for this deposit is running. */
  | { kind: "checking" }
  /** Capacity is known, but the amount the portal would credit is not (a conversion route). */
  | ({ kind: "unavailable"; cause: "amount-unknown"; availableAtomic: bigint } & Observed)
  /** No current read. `last` is the previous observation; it is not current. */
  | {
      kind: "unavailable"
      cause: "capacity-unread"
      last?: { availableAtomic: bigint } & Observed
    }
  /** The deposit's portal is not known on this wallet's L1 chain. */
  | { kind: "unavailable"; cause: "portal-unknown" }

export type SipaProcessingKind = SipaProcessingReason["kind"]

/** One wording per reason, so the activity row, the detail sheet and the notification agree. */
export const SIPA_PROCESSING_COPY: Record<SipaProcessingKind, { headline: string; short: string }> =
  {
    "capacity": { headline: "Waiting for network capacity", short: "Waiting for capacity" },
    "ceiling": { headline: "Too large for network capacity", short: "Too large to process" },
    "operation-cap": { headline: "Too large for one deposit", short: "Too large to process" },
    "processing": { headline: "Waiting for processing", short: "Waiting for processing" },
    "checking": { headline: "Checking deposit status", short: "Checking status" },
    "unavailable": { headline: "Reason unavailable", short: "Reason unavailable" },
  }

/** A confirmed reason the manual sweep cannot land now. */
export interface SipaSweepBlocker {
  kind: "capacity" | "ceiling" | "operation-cap"
  observedAt: number
  /** Set when the blocker was confirmed without a known credit: capacity was zero. */
  zeroCapacity?: true
}

export interface SipaProcessingState {
  reason: SipaProcessingReason
  /** The last confirmed blocker, kept until a later read shows it is gone. */
  blocker?: SipaSweepBlocker
}

/** Funds sit at the deposit address and no sweep of them has been seen. */
export function isAwaitingSweep(
  record: Pick<SIPADepositRecord, "phase" | "amount" | "sweepTxHash" | "inboxIndex" | "netAmount">,
): boolean {
  return (
    (record.phase === "funded" || record.phase === "broadcast" || record.phase === "sweeping") &&
    !isUnfundedSipaDeposit(record as SIPADepositRecord) &&
    !record.sweepTxHash &&
    !record.inboxIndex &&
    record.netAmount == null
  )
}

/**
 * The blocker after `reason`. A confirmed blocker replaces the previous one. Only a later read that shows the blocker
 * is gone clears it: a fit, or, for a zero-capacity blocker on an unknown credit, capacity above zero. A read that is
 * missing, stale or still running keeps it.
 */
export function nextSipaSweepBlocker(
  previous: SipaSweepBlocker | undefined,
  reason: SipaProcessingReason,
): SipaSweepBlocker | undefined {
  switch (reason.kind) {
    case "capacity":
      return reason.requiredAtomic === undefined
        ? { kind: "capacity", observedAt: reason.observedAt, zeroCapacity: true }
        : { kind: "capacity", observedAt: reason.observedAt }
    case "ceiling":
    case "operation-cap":
      return { kind: reason.kind, observedAt: reason.observedAt }
    case "processing":
      return previous && reason.observedAt <= previous.observedAt ? previous : undefined
    case "unavailable":
      return previous?.zeroCapacity &&
        reason.cause === "amount-unknown" &&
        reason.availableAtomic > 0n &&
        reason.observedAt > previous.observedAt
        ? undefined
        : previous
    case "checking":
      return previous
  }
}

/**
 * Whether a surface states `state`'s reason now, so the activity row, the sheets and the notification apply one rule.
 * A confirmed blocker, or a remembered one, is said at once. Waiting for processing and checking wait for the stuck
 * clock: a healthy deposit a relayer is about to sweep is not labeled delayed. An unavailable reason is never said, as
 * it tells the user nothing. Until a reason is said, each surface keeps its phase wording.
 */
export function sipaReasonShown(
  state: SipaProcessingState | undefined,
  record: Pick<SIPADepositRecord, "phase" | "startTime" | "sweepTxHash">,
  now: number = Date.now(),
): state is SipaProcessingState {
  if (!state) return false
  const kind = state.reason.kind
  if (state.blocker || kind === "capacity" || kind === "ceiling" || kind === "operation-cap") {
    return true
  }
  return kind !== "unavailable" && isStuckSweep(record, now)
}

/**
 * Whether capacity allows a manual sweep. Only a remembered confirmed blocker refuses it; the sweep's own rules still
 * apply, and recovery never depends on this.
 */
export function sipaSweepAllowed(state: SipaProcessingState | undefined): boolean {
  return !state?.blocker
}
