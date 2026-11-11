import { formatUnits } from "viem"
import type { Address, Hash } from "viem"
import type { SIPADepositPhase } from "@obsidion/core/types"
import { notElsewhere, type OnNetwork } from "../types/networkStamp"
import { WalletError, type Failure } from "./errors"
import type {
  OwedBroadcast,
  SIPASweep,
  SipaBroadcast,
  SipaBroadcastWait,
  SipaDeposit,
  SipaSweepRow,
} from "./sipaDeposits"

/** The record schema the transition writes: version 2 stamps each sweep with the row it settled on. */
export const SIPA_DEPOSIT_RECORD_VERSION = 2

/** A record's id: its lowercase address. */
export const sipaDepositId = (address: string) => address.toLowerCase()

/** A new record, whole: `phase` is the one it starts in. */
export type SipaDepositFields = OnNetwork<SipaDeposit>

/** What an observation may set: everything but the claim ledger, which only `claimed` writes. */
export type SipaObservation = Partial<
  Omit<SipaDeposit, "sipaAddress" | "claimedInboxIndexes" | "sweeps" | "broadcast">
>

/**
 * What changes a SIPA deposit record. Creation events make a record only when none exists; on one
 * that does they fill empty fields.
 */
export type SipaDepositEvent =
  /** This wallet derived the address: a hand-out, a pool fill or a request link. */
  | { type: "derived"; fields: SipaDepositFields }
  /** A registration's claim inputs, with its fee. */
  | { type: "seeded"; fields: SipaDepositFields }
  /** A backup passkey rotation's funding address. */
  | { type: "rotationSeeded"; fields: SipaDepositFields }
  /** An event, a stray sweep or a resolver payment named an address with no record here. */
  | { type: "discovered"; fields: SipaDepositFields }
  /** An upgrade batch's direct deposit; `expected` fills in on an existing record once. */
  | { type: "directBatch"; fields: SipaDepositFields }
  /** Read off another database's records. */
  | { type: "imported"; fields: SipaDepositFields }
  /** What a pass read on chain. `ledger` is a claimed sweep's entry, filed in inbox order. */
  | { type: "observed"; fields: SipaObservation; ledger?: SIPASweep }
  /** A replayed registration record that turned out to be a user operation's: it goes. */
  | { type: "misfiled" }
  /** The pass asked for the funded, overdue address to be published again. */
  | { type: "republishDue"; at: number }
  /** Version 1 sweeps all settled on the one bridge `pinned` names. */
  | { type: "sweepRowsStamped"; networkId: string; pinned: SipaSweepRow }
  /** A sweep's claim landed in the PXE; the record reads `claimed` once the balance holds it. */
  | { type: "claimLanded"; inboxIndex: string; at: number }
  /** A sweep's claim settled; `endTime` dates a replayed deposit at its sweep. */
  | { type: "claimed"; sweep: SIPASweep; endTime?: number }
  /** The address was handed out now: an unfunded record's clock restarts. */
  | { type: "shown"; at: number }
  /** This device's funding transfer confirmed. */
  | {
      type: "fundingSent"
      fields: Pick<
        Partial<SipaDeposit>,
        "fundingTxHash" | "walletName" | "walletAddress" | "tokenSymbol"
      >
    }
  /** The funding tx's receipt was read: it was a plain transfer or a bridge fill. Set once. */
  | { type: "fundingRead"; funding: NonNullable<SipaDeposit["funding"]> }
  /** A sweep this wallet sent, or one the registration's detection saw. */
  | { type: "sweepSent"; txHash: Hash }
  /**
   * A recovery's hash, saved before its receipt and again once `confirmed`, with the token it moved
   * when known. `ifUnsettled` leaves a record a sync settled meanwhile as it is.
   */
  | {
      type: "recoverySent"
      txHash: Hash
      confirmed?: boolean
      token?: { tokenAddress: Address; tokenSymbol?: string; tokenDecimals?: number }
      ifUnsettled?: boolean
    }
  /** The recovery `txHash` reverted. */
  | { type: "recoveryReverted"; txHash: Hash }
  /** A refunded registration address takes a new deposit. */
  | { type: "reentered" }
  /** The address's broadcast is owed. One already owed keeps its progress; shown and funded move on. */
  | { type: "broadcastOwed"; address: string; owed: OwedBroadcast; at: number }
  /** The user asked for another try: clears a queued broadcast's backoff and failure count. */
  | { type: "broadcastRetry" }
  | { type: "broadcastProving"; operationId?: string }
  /** The proven tx's hash, saved before the node takes the tx. */
  | { type: "broadcastHash"; txHash: string }
  /** The node took the tx whose hash the record holds. */
  | { type: "broadcastSent"; txHash: string }
  | { type: "broadcastLanded" }
  /** The attempt failed: back to the queue after a backoff. */
  | { type: "broadcastFailed"; failure: Failure; at: number }
  /** Not possible yet: tried again at `until`. */
  | { type: "broadcastDeferred"; until: number; wait?: SipaBroadcastWait }
  /** A page stopped mid-attempt: the chain decides a known hash, anything else is owed again. */
  | { type: "broadcastInterrupted" }
  /** Nothing is left to publish: the broadcast leaves the record. */
  | { type: "broadcastAbandoned" }
  /** Paid again or overdue: the broadcast is owed again, landing only at or after `sinceBlock`. */
  | { type: "broadcastRepublish"; sinceBlock: number; at: number }

/**
 * Phases with nothing left to observe: the deposit is credited (`claimed`), abandoned (`failed`), or
 * pulled back out on L1 (`recovered`).
 */
const SETTLED_PHASES: ReadonlySet<SIPADepositPhase> = new Set(["claimed", "failed", "recovered"])

export function isSettledSipaPhase(phase: SIPADepositPhase): boolean {
  return SETTLED_PHASES.has(phase)
}

const BEFORE_SWEEP: ReadonlySet<SIPADepositPhase> = new Set([
  "resolved",
  "funding",
  "funded",
  "broadcast",
])

// eslint-disable-next-line no-restricted-syntax -- debt
const CREATIONS = new Set<SipaDepositEvent["type"]>([
  "derived",
  "seeded",
  "rotationSeeded",
  "discovered",
  "directBatch",
  "imported",
])

/** Whether `event` makes a record where none exists. */
function createsSipaDeposit(event: SipaDepositEvent): boolean {
  return CREATIONS.has(event.type)
}

/** The ledger with `entry` in place of any earlier entry for its sweep, in inbox order. */
export function withSweep(sweeps: readonly SIPASweep[] | undefined, entry: SIPASweep): SIPASweep[] {
  return [...(sweeps ?? []).filter((s) => s.inboxIndex !== entry.inboxIndex), entry].sort((a, b) =>
    BigInt(a.inboxIndex) < BigInt(b.inboxIndex) ? -1 : 1,
  )
}

/** The first terminal entry's time sticks. */
function stampTerminal(record: SipaDeposit, now: number): SipaDeposit {
  return SETTLED_PHASES.has(record.phase) && !record.endTime ? { ...record, endTime: now } : record
}

/** The fields an existing record lacks, from a creation event. */
function backfill(record: SipaDeposit, event: SipaDepositEvent & { fields: SipaDepositFields }) {
  const { fields } = event
  // A record that only held a broadcast becomes the one created, keeping the broadcast and slot.
  if (isBroadcastStub(record))
    return {
      version: SIPA_DEPOSIT_RECORD_VERSION,
      ...fields,
      networkId: fields.networkId.toLowerCase(),
      ...(record.slot ? { slot: record.slot } : {}),
      broadcast: record.broadcast,
    }
  const filled: Partial<SipaDeposit> = {}
  if (!record.messageSecret && fields.messageSecret) filled.messageSecret = fields.messageSecret
  if (!record.recipientHash && fields.recipientHash) filled.recipientHash = fields.recipientHash
  if (!record.recoveryAddress && fields.recoveryAddress)
    filled.recoveryAddress = fields.recoveryAddress
  if (!record.origin && fields.origin) filled.origin = fields.origin
  if (!record.intent && fields.intent) filled.intent = fields.intent
  if (!record.slot && fields.slot) filled.slot = fields.slot
  if (event.type === "seeded" && record.registrationFee === undefined && fields.registrationFee)
    filled.registrationFee = fields.registrationFee
  if (event.type === "directBatch" && record.direct && record.direct.expected === undefined)
    filled.direct = { ...record.direct, expected: fields.direct?.expected }
  return Object.keys(filled).length > 0 ? { ...record, ...filled } : undefined
}

/** Evidence of funds new to a settled record: a balance, or a sweep it has not claimed. */
function newFunds(record: SipaDeposit, fields: SipaObservation): boolean {
  if (fields.amount !== undefined && /[1-9]/.test(fields.amount)) return true
  return fields.inboxIndex !== undefined && !record.claimedInboxIndexes?.includes(fields.inboxIndex)
}

/** `pending` without the sweeps the record has claimed. */
function unclaimed(record: SipaDeposit, pending: SipaDeposit["pendingSweeps"]) {
  const claimed = new Set(record.claimedInboxIndexes ?? [])
  const left = pending?.filter((s) => !claimed.has(s.inboxIndex))
  return left?.length ? left : undefined
}

/**
 * The record fields that read as `sweep`, in the units of the token it credited. A funding token
 * the sweep does not name leaves the record's.
 */
export function sipaSweepFields(sweep: SIPASweep): SipaObservation {
  return {
    inboxIndex: sweep.inboxIndex,
    netAmount: sweep.netAmount,
    ...(sweep.tokenDecimals === undefined
      ? {}
      : { amount: formatUnits(BigInt(sweep.netAmount), sweep.tokenDecimals) }),
    tokenAddress: sweep.tokenAddress,
    rowToken: undefined,
    tokenSymbol: sweep.tokenSymbol,
    tokenDecimals: sweep.tokenDecimals,
    sweepTxHash: sweep.sweepTxHash,
    ...(sweep.fundingTokenSymbol ? { fundingTokenSymbol: sweep.fundingTokenSymbol } : {}),
    fee: sweep.fee,
  }
}

/**
 * A pass dropped the record's last pending sweep as reorged away: nothing is left to claim, so it
 * reads as what the SIPA holds now.
 */
function sweepReorged(record: SipaDeposit): SipaDeposit {
  // The record reads as its latest sweep: the last one the ledger holds.
  const last = record.sweeps?.at(-1)
  const kept: SipaDeposit = last ? { ...record, ...sipaSweepFields(last) } : record
  if (/[1-9]/.test(record.heldBalance ?? "")) return { ...kept, phase: "sweeping" }
  if (record.claimedInboxIndexes?.length) return { ...kept, phase: "claimed" }
  return {
    ...record,
    phase: "broadcast",
    amount: "0",
    netAmount: undefined,
    inboxIndex: undefined,
    sweepTxHash: undefined,
  }
}

function withSweepRows(record: SipaDeposit, pinned: SipaSweepRow): SipaDeposit {
  const row = {
    portal: pinned.portal,
    l2Token: pinned.l2Token,
    tokenAddress: pinned.token.address,
    tokenSymbol: pinned.token.symbol,
    tokenDecimals: pinned.token.decimals,
  }
  // The record's fee is its latest sweep's; no older sweep's fee is known.
  const feeOf = (sweep: SIPASweep) =>
    record.fee !== undefined && sweep.inboxIndex === record.inboxIndex ? { fee: record.fee } : {}
  return {
    ...record,
    version: SIPA_DEPOSIT_RECORD_VERSION,
    ...(record.sweeps
      ? { sweeps: record.sweeps.map((sweep) => ({ ...row, ...feeOf(sweep), ...sweep })) }
      : {}),
  }
}

const RETRY_BACKOFF_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000]

/** Wait before the next attempt after `failures` failed ones. A broadcast never stops retrying. */
export function retryDelay(failures: number): number {
  return RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length) - 1] ?? 0
}

type BroadcastEvent = Extract<SipaDepositEvent, { type: `broadcast${string}` }>

/** Funds are waiting on it: a broadcast backing off runs at once. */
function markFunded(job: SipaBroadcast, at: number): SipaBroadcast {
  if (job.state === "landed" || job.fundedAt !== undefined) return job
  return { ...job, fundedAt: at, retryAt: job.state === "queued" ? undefined : job.retryAt }
}

/**
 * The user saw the address: a pool broadcast, landed or not, becomes theirs and leaves the pool,
 * with none of the pool's failures.
 */
function markShown(job: SipaBroadcast, at: number): SipaBroadcast {
  if (job.kind === "pool")
    return { ...job, shownAt: job.shownAt ?? at, kind: "deposit", failures: 0, retryAt: undefined }
  return job.shownAt === undefined ? { ...job, shownAt: at } : job
}

function owe(job: SipaBroadcast | undefined, owed: OwedBroadcast, at: number): SipaBroadcast {
  if (!job) return { ...owed, createdAt: at, state: owed.txHash ? "sent" : "queued", failures: 0 }
  const seen = owed.shownAt === undefined ? job : markShown(job, owed.shownAt)
  return owed.fundedAt === undefined ? seen : markFunded(seen, owed.fundedAt)
}

/**
 * The relayer sweeps an address once per publish, so its broadcast is owed again: a landed one
 * reopens, an owed one moves to the front. A resweepable address with none owes one its record
 * rebuilds, which the executor drops if the record no longer deploys there; any other publishes
 * only from the inputs its own device signed.
 */
function republish(
  record: SipaDeposit,
  { sinceBlock, at }: Extract<BroadcastEvent, { type: "broadcastRepublish" }>,
): SipaBroadcast | undefined {
  const job = record.broadcast
  if (!job)
    return record.origin?.resweepable
      ? owe(
          undefined,
          { kind: "deposit", source: { type: "slot" }, fundedAt: at, republishSince: sinceBlock },
          at,
        )
      : undefined
  return job.state === "landed"
    ? {
        ...job,
        state: "queued",
        republishSince: sinceBlock,
        fundedAt: at,
        failures: 0,
        retryAt: undefined,
        txHash: undefined,
        failure: undefined,
        wait: undefined,
        operationId: undefined,
      }
    : markFunded(job, at)
}

/**
 * A broadcast's next state: `null` when it leaves the record, `undefined` when it stays as it is.
 * A landed broadcast is final but for a republish; `sent` takes the hash already saved.
 */
function broadcastTransition(
  record: SipaDeposit,
  event: BroadcastEvent,
): SipaBroadcast | null | undefined {
  const job = record.broadcast
  if (event.type === "broadcastOwed") return owe(job, event.owed, event.at)
  if (event.type === "broadcastRepublish") return republish(record, event)
  if (!job) return undefined
  if (job.state === "landed") return undefined
  switch (event.type) {
    case "broadcastRetry":
      return job.state === "queued" && (job.failures > 0 || job.retryAt !== undefined)
        ? { ...job, failures: 0, retryAt: undefined }
        : undefined
    case "broadcastProving":
      return {
        ...job,
        state: "proving",
        retryAt: undefined,
        txHash: undefined,
        wait: undefined,
        operationId: event.operationId ?? job.operationId,
      }
    case "broadcastHash":
      return job.txHash === event.txHash ? undefined : { ...job, txHash: event.txHash }
    case "broadcastSent":
      return job.txHash ? { ...job, state: "sent", txHash: event.txHash } : undefined
    case "broadcastLanded":
      return { ...job, state: "landed", retryAt: undefined }
    case "broadcastFailed": {
      const failures = job.failures + 1
      return {
        ...job,
        state: "queued",
        failures,
        failure: event.failure,
        wait: undefined,
        txHash: undefined,
        retryAt: event.at + retryDelay(failures),
      }
    }
    case "broadcastDeferred":
      return { ...job, state: "queued", wait: event.wait, retryAt: event.until }
    case "broadcastInterrupted":
      return job.state === "proving" ? { ...job, state: job.txHash ? "sent" : "queued" } : undefined
    case "broadcastAbandoned":
      return null
  }
}

/**
 * A record that holds only `job`: the broadcast of an address with no deposit record yet. Nothing
 * observes it until a creation event fills it in.
 */
export function broadcastStub(address: string, job: SipaBroadcast): SipaDeposit {
  return {
    sipaAddress: address.toLowerCase() as Address,
    recipientL2Address: "",
    messageSecret: "",
    recipientHash: "",
    recoveryAddress: "",
    l1ChainId: 0,
    amount: "0",
    tokenSymbol: "",
    phase: "resolved",
    startTime: job.createdAt,
    broadcast: job,
  }
}

/** A record holding only its broadcast: `broadcastStub`'s chain id is no chain's. */
function isBroadcastStub(record: SipaDeposit): boolean {
  return record.l1ChainId === 0 && !record.recipientL2Address && !record.messageSecret
}

/** `record` with `job` as its broadcast. */
function withBroadcast(
  record: SipaDeposit,
  job: SipaBroadcast | null | undefined,
): SipaDeposit | undefined {
  if (job === undefined || job === record.broadcast) return undefined
  return { ...record, broadcast: job ?? undefined }
}

/**
 * The one place a SIPA deposit record changes: the next record, `undefined` to leave it as it is,
 * or `null` to remove it.
 * - Creation events make a record only when none exists, stamped with its lowercase network.
 * - Leaving `claimed`, `failed` or `recovered` takes new funds; entering one stamps `endTime` once.
 */
export function sipaDepositTransition(
  record: SipaDeposit | undefined,
  event: SipaDepositEvent,
  now: number,
): SipaDeposit | null | undefined {
  if (!record) {
    if (event.type === "broadcastOwed")
      return broadcastStub(event.address, owe(undefined, event.owed, event.at))
    if (!createsSipaDeposit(event) || !("fields" in event)) return undefined
    const fields = event.fields as SipaDepositFields
    if (!fields.networkId)
      throw new WalletError("invariant", `sipaDeposits: ${event.type} carries no network`)
    return stampTerminal(
      {
        version: SIPA_DEPOSIT_RECORD_VERSION,
        ...fields,
        networkId: fields.networkId.toLowerCase(),
      },
      now,
    )
  }
  switch (event.type) {
    case "derived":
    case "seeded":
    case "rotationSeeded":
    case "discovered":
    case "directBatch":
    case "imported":
      return backfill(record, event)
    case "observed": {
      const { phase, ...fields } = event.fields
      const reopens =
        phase !== undefined && SETTLED_PHASES.has(record.phase) && !SETTLED_PHASES.has(phase)
      let next: SipaDeposit = {
        ...record,
        ...fields,
        phase:
          phase === undefined || (reopens && !newFunds(record, event.fields))
            ? record.phase
            : phase,
        ...(event.ledger ? { sweeps: withSweep(record.sweeps, event.ledger) } : {}),
      }
      if ("pendingSweeps" in event.fields) {
        next.pendingSweeps = unclaimed(next, fields.pendingSweeps)
        if (next.phase === "pendingClaim" && !next.pendingSweeps && record.pendingSweeps?.length)
          next = sweepReorged(next)
      }
      // A sender paid an address whose broadcast is still owed: it moves to the front.
      if (next.broadcast?.source.type === "slot" && /[1-9]/.test(next.amount))
        next.broadcast = markFunded(next.broadcast, now)
      return stampTerminal(next, now)
    }
    case "misfiled":
      return maybeMisfiled(record) ? null : undefined
    case "republishDue":
      return { ...record, republishAskedAt: event.at }
    case "sweepRowsStamped":
      return (record.version ?? 1) < SIPA_DEPOSIT_RECORD_VERSION &&
        notElsewhere(record, event.networkId)
        ? withSweepRows(record, event.pinned)
        : undefined
    case "claimLanded":
      return { ...record, claimLanded: { inboxIndex: event.inboxIndex, at: event.at } }
    case "claimed": {
      const index = event.sweep.inboxIndex
      const claimedInboxIndexes = record.claimedInboxIndexes?.includes(index)
        ? record.claimedInboxIndexes
        : [...(record.claimedInboxIndexes ?? []), index]
      const ledgered = {
        ...record,
        claimedInboxIndexes,
        sweeps: withSweep(record.sweeps, event.sweep),
      }
      // The record reads as its latest sweep: a newer one still pending keeps it pending.
      const newer = record.pendingSweeps?.some((s) => BigInt(s.inboxIndex) > BigInt(index))
      const next: SipaDeposit = newer
        ? ledgered
        : {
            ...ledgered,
            ...sipaSweepFields(event.sweep),
            ...(event.endTime === undefined ? {} : { endTime: event.endTime }),
            phase: "claimed",
          }
      next.pendingSweeps = unclaimed(next, record.pendingSweeps)
      return newer ? next : stampTerminal(next, now)
    }
    case "shown": {
      const job = record.broadcast && markShown(record.broadcast, event.at)
      const restamped = isUnfundedSipaDeposit(record) ? { ...record, startTime: event.at } : record
      const next = job !== record.broadcast ? { ...restamped, broadcast: job } : restamped
      return next === record ? undefined : next
    }
    case "fundingSent": {
      const defined = Object.entries(event.fields).filter(([, v]) => v !== undefined)
      const job = record.broadcast && markFunded(record.broadcast, now)
      if (defined.length === 0 && job === record.broadcast) return undefined
      return { ...record, ...Object.fromEntries(defined), broadcast: job }
    }
    case "fundingRead":
      return record.funding ? undefined : { ...record, funding: event.funding }
    case "sweepSent": {
      const phase = BEFORE_SWEEP.has(record.phase) ? "sweeping" : record.phase
      if (phase === record.phase && record.sweepTxHash) return undefined
      return { ...record, phase, sweepTxHash: record.sweepTxHash ?? event.txHash }
    }
    case "recoverySent": {
      if (event.ifUnsettled && SETTLED_PHASES.has(record.phase)) return undefined
      const token = Object.fromEntries(
        Object.entries(event.token ?? {}).filter(([, v]) => v !== undefined),
      )
      const phase = event.confirmed ? "recovered" : record.phase
      return stampTerminal({ ...record, ...token, phase, recoveryTxHash: event.txHash }, now)
    }
    case "recoveryReverted":
      return record.recoveryTxHash === event.txHash && record.phase !== "recovered"
        ? { ...record, recoveryTxHash: undefined }
        : undefined
    case "reentered":
      return record.phase === "recovered"
        ? {
            ...record,
            phase: "broadcast",
            amount: "0",
            recoveryTxHash: undefined,
            endTime: undefined,
          }
        : undefined
    default:
      return withBroadcast(record, broadcastTransition(record, event))
  }
}

/**
 * A replayed registration record never swept as one: a user operation's event reads as a registration
 * until its clone is swept. A registration's own sweep settles the question; stray funds sent to the
 * address do not.
 */
export function maybeMisfiled(record: SipaDeposit | null | undefined): record is SipaDeposit {
  return (
    !!record &&
    record.intent === "registration" &&
    !!record.replayed &&
    !record.sweepTxHash &&
    !record.inboxIndex &&
    !record.sweeps?.length
  )
}

/**
 * A deposit address that was derived and broadcast but never paid. Opening Add funds publishes one
 * whether or not the visitor goes on to send anything, and discovery records it at `amount: "0"` —
 * publishing an address is not an incoming payment, so it must neither sit in the feed as "Pending"
 * nor spin under the bell. Any evidence that funds arrived (a nonzero amount, a sweep, an
 * advanced phase) shows the row.
 */
export function isUnfundedSipaDeposit(record: SipaDeposit): boolean {
  return (
    (record.phase === "broadcast" || record.phase === "resolved") &&
    Number(record.amount) === 0 &&
    !record.sweepTxHash &&
    !record.inboxIndex
  )
}
