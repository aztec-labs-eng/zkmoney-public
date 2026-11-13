/**
 * What a backup add costs and how long it takes: the quote before it starts, and where a paid add
 * stands against it. Amounts are in the fee token, an 18-decimal dollar token.
 */
import { L1_SETTLED_DEPTH } from "@obsidion/core/constants"
import type { FundingAmount } from "@obsidion/sdk"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import {
  fundingLanding,
  type BackupRotationPhase,
  type BackupRotationRecord,
} from "./backupRotations"

/** A proven funding's release, its sweep, and Ethereum finalizing that sweep. */
const SETTLE_MS = 15 * 60_000

/** The time of an add planned without one: the wait the Fund step quotes. */
export const BACKUP_ADD_TAKES_MS = 40 * 60_000

/**
 * How far past its bound a paid add counts as delayed. The bound takes the prover's usual
 * latency, so this leaves room for a slow proof, release or sweep.
 */
export const BACKUP_ADD_DELAYED_AFTER_MS = 15 * 60_000

/** What an add charges. The credit that lands on the two-key account stays the user's. */
export interface BackupAddFees {
  total: bigint
  /** Every charge but the sweep tip; gas does not move them. */
  fixed: bigint
  /** The sweep tip, which pays the sweep's Ethereum gas. */
  network: bigint
}

export function backupAddFees(
  funding: Pick<FundingAmount, "amount" | "credited" | "breakdown">,
): BackupAddFees {
  const total = funding.amount - funding.credited
  const network = funding.breakdown.sweepTip
  return { total, fixed: total - network, network }
}

/** The figures shown before the add starts. */
export type BackupAddQuote = BackupAddFees

/**
 * The most an add takes from paying to the last approval: the bound the delayed rule reads. The
 * funding's burn lands within `landingSeconds`. With no prover tip it waits for its epoch's full
 * proof, at worst a whole epoch and a full proof after it lands, wherever in the epoch that is.
 * Then it settles on Ethereum.
 */
export function backupAddTakesMs(
  landingSeconds: number,
  epoch: { epochDuration: number; slotDuration: number },
  fullProofSeconds: number,
): number {
  const epochSeconds = epoch.epochDuration * epoch.slotDuration
  return Math.round((landingSeconds + epochSeconds + fullProofSeconds) * 1000) + SETTLE_MS
}

/** A funding of the record went out and was not lost: the add has charged the user. */
const charged = (record: Pick<BackupRotationRecord, "fundings">): boolean =>
  record.fundings.some((f) => fundingLanding(f) || f.outcome === "swept")

/**
 * The add waits, before charging anything, for the sweep to be paid at today's gas: the route
 * check before publishing and funding parked it.
 */
export const waitsOnGas = (
  record: Pick<BackupRotationRecord, "phase" | "attention" | "suspended" | "fundings">,
): boolean =>
  record.phase === "attention" &&
  record.attention === "route" &&
  (record.suspended === "signed" || record.suspended === "published") &&
  !charged(record)

/** Phases a paid add waits on the chain in, before the move asks for the last approval. */
const WAITING: ReadonlySet<BackupRotationPhase> = new Set(["funded", "swept", "installed"])

export interface BackupAddTiming {
  /** Past its time by {@link BACKUP_ADD_DELAYED_AFTER_MS}, or held until the route pays again. */
  delayed: boolean
}

/**
 * Whether a paid add is past its quoted time, counted from the latest funding sent. Undefined
 * before a funding goes out and once the add no longer waits on the chain.
 */
export function backupAddTiming(
  record: BackupRotationRecord,
  now: number,
): BackupAddTiming | undefined {
  const parked = record.phase === "attention" && record.attention === "route"
  const phase = parked ? record.suspended : record.phase
  if (!phase || !WAITING.has(phase)) return undefined
  const sentAt = record.fundings.filter((f) => f.txHash).at(-1)?.sentAt
  if (sentAt === undefined) return undefined
  const expectedAt = sentAt + (record.plan?.takesMs ?? BACKUP_ADD_TAKES_MS)
  return { delayed: parked || now >= expectedAt + BACKUP_ADD_DELAYED_AFTER_MS }
}

/** When a funding burn is released, from the withdrawal estimator. */
export interface BackupAddRelease {
  /** Seconds until the burn lands: this device's expected landing, or 0 for a burn that has. */
  landingSeconds: number
  /** A landed burn's block time, in seconds: the ETAs run from it. */
  landedAt?: number
  /** Seconds from the landing to the release, without a prover tip and with one. */
  standardEtaSeconds: number
  tippedEtaSeconds: number
  /** Ethereum's slot, which the settled depth counts in. */
  l1SlotSeconds: number
}

export interface BackupAddEta {
  seconds: number
  /** `seconds` counts down from a time on the funding's row; false for a typical wait. */
  remaining: boolean
}

export type BackupFundingRow = Pick<
  WithdrawalRecord,
  "phase" | "startTime" | "minedAt" | "phaseEnteredAt" | "endTime" | "proverTip"
>

/** The Ethereum slots a relayer takes to send the release or the sweep once it can. */
const RELAYER_PICKUP_SLOTS = 2

/** The sweep's pickup, then its block settled. */
const sweepSeconds = (l1SlotSeconds: number) =>
  (RELAYER_PICKUP_SLOTS + Number(L1_SETTLED_DEPTH)) * l1SlotSeconds

/**
 * The add's wait on the network, from the funding's send to its sweep settled: the typical wait
 * before the funding lands, the time left by the row's phase once it has. Zero once the sweep is
 * seen or the countdown has run out. Undefined where there is nothing to estimate: a failed burn,
 * or a phase the add never passes through. The row's own tip picks the release; `speed` stands in
 * before there is a row.
 */
export function backupAddEta(
  record: Pick<BackupRotationRecord, "phase" | "attention" | "suspended"> | undefined,
  funding: BackupFundingRow | undefined,
  release: BackupAddRelease,
  nowMs: number,
  speed: { tipped: boolean },
): BackupAddEta | undefined {
  const parked = record?.phase === "attention" && record.attention === "route"
  const phase = parked ? record.suspended : record?.phase
  if (phase === "swept" || phase === "installed") return { seconds: 0, remaining: true }
  const tipped = funding ? BigInt(funding.proverTip ?? 0) > 0n : speed.tipped
  const eta = tipped ? release.tippedEtaSeconds : release.standardEtaSeconds
  const tail = RELAYER_PICKUP_SLOTS * release.l1SlotSeconds + sweepSeconds(release.l1SlotSeconds)
  const now = nowMs / 1000
  const left = (atMs: number, seconds: number): BackupAddEta => ({
    seconds: Math.max(0, atMs / 1000 + seconds - now),
    remaining: true,
  })
  switch (funding?.phase) {
    case undefined:
    case "submitting":
      return { seconds: release.landingSeconds + eta + tail, remaining: false }
    case "l2_mined":
    case "awaiting_proven": {
      // The device's first sighting stands in until the block's time is read.
      const landedAt = release.landedAt === undefined ? undefined : release.landedAt * 1000
      return left(landedAt ?? funding.minedAt ?? funding.startTime, eta + tail)
    }
    case "finalizing_l1":
      return left(funding.phaseEnteredAt ?? nowMs, tail)
    case "done":
      return left(funding.endTime ?? nowMs, sweepSeconds(release.l1SlotSeconds))
    default:
      return undefined
  }
}

/** A funding of the add, in base units: what leaves the balance, and the part that comes back. */
export interface BackupFundingSplit {
  sent: bigint
  credited: bigint
}

/** What the add charged: the plan's funding, its fees being what does not come back. */
export function backupAddCharged(
  record: Pick<BackupRotationRecord, "plan" | "fundings">,
): BackupFundingSplit | undefined {
  const { plan } = record
  if (!plan || !charged(record)) return undefined
  return { sent: BigInt(plan.fundingAmount), credited: BigInt(plan.credited) }
}

/** What the move sent to the two-key account, by token: every send included and not reverted. */
export function backupAddMoved(
  record: Pick<BackupRotationRecord, "move">,
): ReadonlyMap<string, bigint> {
  const moved = new Map<string, bigint>()
  for (const run of record.move?.runs ?? []) {
    for (const chunk of run.chunks) {
      if ((chunk.state !== "included" && chunk.state !== "mined") || chunk.effect === "reverted")
        continue
      moved.set(chunk.token, (moved.get(chunk.token) ?? 0n) + BigInt(chunk.amount))
    }
  }
  return moved
}
