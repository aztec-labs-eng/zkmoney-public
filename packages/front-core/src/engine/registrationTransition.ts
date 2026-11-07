import type { Hex } from "viem"
import {
  isTerminalRegistrationPhase,
  type PendingRegistrationPhase,
  type PendingRegistrationRecord,
  type RegistrationRoute,
  type RegistrationTerms,
} from "./registrationRecord"

/** What a session commits a new record from; the transition sets its phase and counters. */
export type RegistrationStart = Omit<
  PendingRegistrationRecord,
  | "phase"
  | "broadcast"
  | "retries"
  | "startTime"
  | "endTime"
  | "terms"
  | "route"
  | "tagConfirmed"
  | "refunds"
  | "notice"
  | "lapsedAt"
  | "fundedAt"
  | "firstFundedAt"
  | "fundingTxHash"
  | "sweptAt"
  | "sweepTxHash"
>

export type RegistrationOutcome = "confirmed" | "taken" | "failed" | "recovery"

/** What changes a registration record. */
export type RegistrationEvent =
  | {
      type: "started"
      record: RegistrationStart
      terms?: RegistrationTerms
      route?: RegistrationRoute
    }
  /** An earned-quote replacement or a moved derivation closed the address. */
  | { type: "replaced" }
  | { type: "funded"; fundingTxHash?: Hex }
  | { type: "swept"; txHash: Hex }
  /** A refund off the address; `entry` is the wallet entry it bought, when it bought one. */
  | {
      type: "refunded"
      txHash: Hex
      amount?: string
      entry?: NonNullable<PendingRegistrationRecord["refundedEntry"]>
    }
  | { type: "broadcastSent" }
  /** The account's closed record at `sipaAddress` used the one-shot rail after this one opened. */
  | { type: "predecessorBroadcast"; sipaAddress: string }
  /** An expired quote's retry publishes the address again. */
  | { type: "broadcastReset" }
  | { type: "termsUpdated"; terms: Partial<RegistrationTerms> }
  | { type: "lapsed" }
  /** The Registry settled the name. `tag` and `nameHash` name the one the account holds instead. */
  | { type: "closed"; outcome: RegistrationOutcome; tag?: string; nameHash?: Hex }
  | { type: "noticeAcknowledged" }
  | { type: "abandoned" }
  | { type: "tagConfirmed" }
  | { type: "retried" }

/** A changed record, and the fields this event set for the first time. */
export interface RegistrationChange {
  record: PendingRegistrationRecord
  first: readonly (keyof PendingRegistrationRecord)[]
}

/** The events a closed record still takes. */
const TERMINAL_EVENTS = new Set<RegistrationEvent["type"]>([
  "started",
  "broadcastSent",
  "noticeAcknowledged",
  "refunded",
])

const CLOSES: Record<RegistrationOutcome, PendingRegistrationPhase> = {
  confirmed: "confirmed",
  taken: "failed_taken",
  failed: "failed_terminal",
  recovery: "confirmed",
}

const hasCustody = (r: PendingRegistrationRecord) =>
  r.fundedAt !== undefined || r.sweptAt !== undefined
const swept = (r: PendingRegistrationRecord) =>
  r.sweptAt !== undefined || r.sweepTxHash !== undefined

function opened(
  event: Extract<RegistrationEvent, { type: "started" }>,
  now: number,
): PendingRegistrationRecord {
  return {
    ...event.record,
    ...(event.terms ? { terms: event.terms } : {}),
    ...(event.route ? { route: event.route } : {}),
    phase: "awaiting_deposit",
    broadcast: false,
    retries: 0,
    startTime: now,
  }
}

/** The terms fields that bind a link to the registration it funds. */
export const LINK_BINDING = [
  "paylinkFunded",
  "paylinkId",
  "paylinkDeposit",
  "paylinkAmount",
  "paylinkSender",
  "paylinkBlocked",
  "proverTip",
  "speed",
] as const

/**
 * Terms a renewal of the same open registration brings. A renewal that names no link keeps the
 * link that funds the registration and the choices committed with it, and an earned promise stays.
 */
function renewed(
  previous: RegistrationTerms | undefined,
  terms: RegistrationTerms,
): RegistrationTerms {
  const bound = previous?.paylinkFunded === true && terms.paylinkFunded === undefined
  const kept = bound
    ? Object.fromEntries(
        LINK_BINDING.filter((key) => previous[key] !== undefined).map((key) => [
          key,
          previous[key],
        ]),
      )
    : {}
  return {
    ...kept,
    ...terms,
    ...(previous?.earnedExpected || terms.earnedExpected ? { earnedExpected: true } : {}),
  }
}

function next(
  record: PendingRegistrationRecord | undefined,
  event: RegistrationEvent,
  now: number,
): PendingRegistrationRecord | undefined {
  if (event.type === "started") {
    if (!record) return opened(event, now)
    if (!isTerminalRegistrationPhase(record.phase))
      return event.terms ? { ...record, terms: renewed(record.terms, event.terms) } : undefined
    // A closed address started again reopens; what the chain told about the address stays.
    const { refunds, tagConfirmed } = record
    return {
      ...opened(event, now),
      ...(refunds ? { refunds } : {}),
      ...(tagConfirmed ? { tagConfirmed } : {}),
    }
  }
  if (!record) return undefined
  if (isTerminalRegistrationPhase(record.phase) && !TERMINAL_EVENTS.has(event.type))
    return undefined
  switch (event.type) {
    case "replaced":
      return { ...record, phase: "replaced" }
    case "funded":
      if (record.phase !== "awaiting_deposit") return undefined
      return {
        ...record,
        phase: "funded",
        fundedAt: record.fundedAt ?? now,
        firstFundedAt: record.firstFundedAt ?? record.fundedAt ?? now,
        ...(event.fundingTxHash ? { fundingTxHash: event.fundingTxHash } : {}),
      }
    case "swept":
      if (record.sweptAt !== undefined) return undefined
      return {
        ...record,
        phase: "funded",
        sweptAt: now,
        sweepTxHash: record.sweepTxHash ?? event.txHash,
        fundedAt: record.fundedAt ?? now,
        firstFundedAt: record.firstFundedAt ?? record.fundedAt ?? now,
      }
    case "refunded": {
      const txHashes = record.refunds?.txHashes ?? []
      const amounts = record.refunds?.amounts ?? {}
      const isNew = !txHashes.includes(event.txHash)
      const sized =
        event.amount !== undefined && !(event.txHash in amounts)
          ? { ...amounts, [event.txHash]: event.amount }
          : undefined
      let out: PendingRegistrationRecord = record
      if (isNew || sized) {
        const kept = sized ?? amounts
        out = {
          ...out,
          refunds: {
            txHashes: isNew ? [...txHashes, event.txHash] : txHashes,
            ...(Object.keys(kept).length > 0 ? { amounts: kept } : {}),
          },
        }
      }
      if (event.entry && !swept(record)) {
        out = { ...out, refundedEntry: event.entry }
        if (!isTerminalRegistrationPhase(record.phase) && hasCustody(record))
          out = { ...out, phase: "awaiting_deposit", fundedAt: undefined, fundingTxHash: undefined }
      }
      return out === record ? undefined : out
    }
    case "broadcastSent":
      return record.broadcast ? undefined : { ...record, broadcast: true }
    case "predecessorBroadcast":
      if (record.replaced?.broadcastSpent) return undefined
      return {
        ...record,
        replaced: {
          sipaAddress: record.replaced?.sipaAddress ?? event.sipaAddress,
          refunded: record.replaced?.refunded ?? false,
          broadcastSpent: true,
        },
      }
    case "broadcastReset":
      if (!record.broadcast || hasCustody(record) || swept(record)) return undefined
      return { ...record, broadcast: false }
    case "termsUpdated":
      return { ...record, terms: { deadline: 0, ...record.terms, ...event.terms } }
    case "lapsed":
      if (record.lapsedAt !== undefined || record.phase !== "awaiting_deposit" || swept(record))
        return undefined
      return { ...record, lapsedAt: now }
    case "closed":
      return {
        ...record,
        phase: CLOSES[event.outcome],
        ...(event.tag ? { tag: event.tag } : {}),
        ...(event.nameHash ? { nameHash: event.nameHash } : {}),
        ...(event.outcome === "recovery" ? { notice: { ...record.notice, recovery: true } } : {}),
      }
    case "noticeAcknowledged": {
      const failed = record.phase === "failed_taken" || record.phase === "failed_terminal"
      if (record.notice?.acknowledged || !(failed || record.notice?.recovery)) return undefined
      return { ...record, notice: { ...record.notice, acknowledged: true } }
    }
    case "abandoned":
      if (hasCustody(record)) return undefined
      return {
        ...record,
        phase: "failed_terminal",
        // The user chose this exit, so it is not also reported back to them as a loss.
        notice: { ...record.notice, acknowledged: true },
      }
    case "tagConfirmed":
      return record.tagConfirmed ? undefined : { ...record, tagConfirmed: true }
    case "retried":
      return { ...record, retries: record.retries + 1 }
  }
}

/**
 * The one place a registration record changes: the next record with the fields this event set for
 * the first time, or `undefined` to leave it as it is. Entering a closed phase stamps `endTime`
 * once. A closed record takes only `TERMINAL_EVENTS`.
 */
export function registrationTransition(
  record: PendingRegistrationRecord | undefined,
  event: RegistrationEvent,
  now: number,
): RegistrationChange | undefined {
  let changed = next(record, event, now)
  if (!changed) return undefined
  if (isTerminalRegistrationPhase(changed.phase) && changed.endTime === undefined)
    changed = { ...changed, endTime: now }
  const after = changed
  const first = (Object.keys(after) as (keyof PendingRegistrationRecord)[]).filter(
    (key) => after[key] !== undefined && record?.[key] === undefined,
  )
  return { record: after, first }
}
