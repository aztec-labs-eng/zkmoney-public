/**
 * What a backup add costs and how long it takes: the quote before it starts, and where a paid add
 * stands against it. Amounts are in the fee token, an 18-decimal dollar token.
 */
import type { FundingAmount } from "@obsidion/sdk"
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
export interface BackupAddQuote extends BackupAddFees {
  takesMs: number
}

/**
 * The most an add takes from paying to the last approval. The funding's burn lands within
 * `landingSeconds`. With no prover tip it waits for its epoch's full proof, at worst a whole epoch
 * and a full proof after it lands, wherever in the epoch that is. Then it settles on Ethereum.
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
  /** At most this long until the last approval. */
  leftMs: number
  /** Past its time by {@link BACKUP_ADD_DELAYED_AFTER_MS}, or held until the route pays again. */
  delayed: boolean
}

/**
 * Where a paid add stands against its quoted time, counted from the latest funding sent. Undefined
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
  return {
    leftMs: Math.max(0, expectedAt - now),
    delayed: parked || now >= expectedAt + BACKUP_ADD_DELAYED_AFTER_MS,
  }
}

/** What the add charged: the plan's fees, once a funding went out. */
export function backupAddCharged(
  record: Pick<BackupRotationRecord, "plan" | "fundings">,
): bigint | undefined {
  const { plan } = record
  if (!plan || !charged(record)) return undefined
  return BigInt(plan.fundingAmount) - BigInt(plan.credited)
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
