/**
 * Upgrade funnel reporters, consented only: the prompt and its answer, a start, each
 * stage's first entry, a failure, a restart and the end. No event carries an amount, address, tag,
 * hash or nullifier.
 *
 * The times live in this browser's wallet store, per account, so an upgrade that ends in a later
 * page load reports its true duration and the page loads it took.
 */
import { useEffect } from "react"
import { WalletError } from "@obsidion/core/errors"
import type { MetadataMigrationPhase, MetadataMigrationRecord } from "@obsidion/front-core"
import { fireEvent } from "../../lib/analytics"
import { firstInTab } from "../../lib/trafficSource"
import { walletStorage } from "../../platform/storage/walletStorage"
import { lap } from "../registration/registrationFunnel"

const STAGES: Partial<Record<MetadataMigrationPhase, MigrationStage>> = {
  preparing: "preparing",
  broadcasting: "broadcasting",
  awaitingMessages: "awaiting_messages",
  subscribing: "subscribing",
  recovering: "recovering",
  arriving: "arriving",
  waiting: "waiting",
}

/** `check`: the check that offers the upgrade failed, before any run. */
export const MIGRATION_STAGES = [
  "check",
  "preparing",
  "broadcasting",
  "awaiting_messages",
  "subscribing",
  "recovering",
  "arriving",
  "waiting",
] as const
export type MigrationStage = (typeof MIGRATION_STAGES)[number]

/** Wallet error codes a thrown upgrade error reports as is; any other is `unknown`. */
export const MIGRATION_ERROR_CODES = [
  "tx.interrupted",
  "tx.failed",
  "sponsorship.paused",
  "sponsorship.feesTooHigh",
  "sponsorship.allowanceExhausted",
  "wallet.notReady",
  "timeout",
  "invariant",
] as const

export const MIGRATION_STOP_CODES = [
  "wrong_account",
  "reverted",
  "recipient",
  "passkey_refused",
  "stale_plan",
  "check_failed",
  "unknown",
] as const
export type MigrationStopCode = (typeof MIGRATION_STOP_CODES)[number]

/** Who can fix a failure: the user, a new plan, the chain, fees, the network, the check, or no one known. */
export const MIGRATION_FAIL_KINDS = [
  "user",
  "plan",
  "chain",
  "fee",
  "network",
  "check",
  "error",
] as const
export type MigrationFailKind = (typeof MIGRATION_FAIL_KINDS)[number]

export const MIGRATION_PROMPT_ACTIONS = ["shown", "upgrade", "withdraw", "closed"] as const
export type MigrationPromptAction = (typeof MIGRATION_PROMPT_ACTIONS)[number]

const HALT_CODES: Record<NonNullable<MetadataMigrationRecord["halt"]>, MigrationStopCode> = {
  account: "wrong_account",
  reverted: "reverted",
  recipient: "recipient",
}

const CODE_KINDS: Record<MigrationStopCode, MigrationFailKind> = {
  passkey_refused: "user",
  wrong_account: "plan",
  recipient: "plan",
  stale_plan: "plan",
  reverted: "chain",
  check_failed: "check",
  unknown: "error",
}

/** What the bell reports for an upgrade that stopped. */
export type MigrationStop = "needsAttention" | "failed"

interface Funnel {
  startedAt?: number
  legs?: number
  /** Page loads that saw the upgrade unfinished, its start's included. */
  sessions?: number
  /** The last time the upgrade moved or stopped in this browser. */
  activeAt?: number
  stage?: MigrationStage
  stages?: MigrationStage[]
  /** The stop last reported, so each is reported once. */
  stop?: string
}

/** The old deployments' labels, deduplicated, sorted and joined with "+". */
export function migrationSource(labels: readonly string[]): string | undefined {
  return labels.length ? [...new Set(labels)].sort().join("+") : undefined
}

const key = (account: string) => `analytics.migrationFunnel/${account.toLowerCase()}`

/** Accounts whose unfinished upgrade this page load counted. */
// eslint-disable-next-line no-restricted-syntax -- debt
const counted = new Set<string>()

/** A new page load, for tests: the wallet store stays. */
export function __newPageLoadForTests(): void {
  counted.clear()
}

function load(account: string): Funnel {
  try {
    // eslint-disable-next-line local/legacy-store -- debt
    return (JSON.parse(walletStorage.getItem(key(account)) ?? "{}") as Funnel) ?? {}
  } catch {
    return {}
  }
}

function save(account: string, funnel: Funnel | undefined): void {
  try {
    if (funnel) walletStorage.setItem(key(account), JSON.stringify(funnel))
    else walletStorage.removeItem(key(account))
  } catch {
    // The next step then reports without the times.
  }
}

/** Analytics must never break the upgrade. */
function safely(report: () => void): void {
  try {
    report()
  } catch {
    // Dropped.
  }
}

/** The offer and each answer to it; `shown` once per tab. */
export function reportMigrationPrompted(
  account: string,
  action: MigrationPromptAction,
  props: { source?: string; trigger?: "auto" | "click"; legs: number },
): void {
  safely(() => {
    if (action === "shown" && !firstInTab(`migration_prompted:${account.toLowerCase()}`)) return
    fireEvent("migration_prompted", { action, ...props })
  })
}

/** The user's own start: the first one starts the upgrade's clock, a later one resumes it. */
export function reportMigrationStart(
  account: string,
  props: { source?: string; batches?: number; legs: number },
  now = Date.now(),
): void {
  safely(() => {
    const funnel = load(account)
    if (funnel.startedAt === undefined) {
      counted.add(account.toLowerCase())
      save(account, { startedAt: now, legs: props.legs, sessions: 1, activeAt: now, stages: [] })
      fireEvent("migration_started", props)
      return
    }
    const gap = funnel.activeAt === undefined ? undefined : lap(now - funnel.activeAt)
    save(account, { ...funnel, activeAt: now, stop: undefined })
    fireEvent("migration_resumed", { stage: funnel.stage, gap_ms: gap })
  })
}

/** A page load that sees the upgrade unfinished counts once. */
export function countMigrationSession(account: string): void {
  safely(() => {
    if (counted.has(account.toLowerCase())) return
    const funnel = load(account)
    if (funnel.startedAt === undefined) return
    counted.add(account.toLowerCase())
    save(account, { ...funnel, sessions: (funnel.sessions ?? 0) + 1 })
  })
}

/** The first entry into each stage, timed from the start. */
export function reportMigrationStage(
  account: string,
  phase: MetadataMigrationPhase,
  now = Date.now(),
): void {
  safely(() => {
    const stage = STAGES[phase]
    const funnel = load(account)
    if (!stage || funnel.startedAt === undefined) return
    const stages = funnel.stages ?? []
    if (!stages.includes(stage)) {
      fireEvent("migration_stage", { stage, since_start_ms: lap(now - funnel.startedAt) })
    }
    if (funnel.stage === stage && stages.includes(stage)) return
    save(account, {
      ...funnel,
      stage,
      stages: stages.includes(stage) ? stages : [...stages, stage],
      activeAt: now,
    })
  })
}

export function migrationStopCode(
  stop: MigrationStop,
  record: MetadataMigrationRecord | null | undefined,
): MigrationStopCode {
  if (stop === "failed") return "check_failed"
  if (record?.halt) return HALT_CODES[record.halt] ?? "unknown"
  if (record?.refused) return "passkey_refused"
  if (record?.stale) return "stale_plan"
  return "unknown"
}

/** The kind of an error the run throws, from its wallet error code. */
export function migrationErrorKind(error: unknown): MigrationFailKind {
  if (!(error instanceof WalletError)) return "error"
  if (error.code.startsWith("sponsorship.")) return "fee"
  if (error.code.startsWith("tx.")) return "chain"
  if (error.code === "timeout") return "network"
  return "error"
}

function fail(account: string, mark: string, step: MigrationStage, props: object, now: number) {
  const funnel = load(account)
  if (funnel.stop === mark) return
  save(account, { ...funnel, stop: mark, activeAt: now })
  fireEvent("migration_step_failed", { step, ...props })
}

/** A run that stopped, once per stop, or a failed check, once per tab. */
export function reportMigrationStop(
  account: string,
  stop: MigrationStop,
  record: MetadataMigrationRecord | null | undefined,
  source?: string,
  now = Date.now(),
): void {
  safely(() => {
    const code = migrationStopCode(stop, record)
    const props = { source, kind: CODE_KINDS[code], code }
    if (stop === "failed") {
      if (firstInTab(`migration_check_failed:${account.toLowerCase()}`))
        fireEvent("migration_step_failed", { step: "check", ...props })
      return
    }
    fail(account, `${record?.id ?? "run"}:${code}`, load(account).stage ?? "preparing", props, now)
  })
}

/** An error the run throws and shows; every one is reported. */
export function reportMigrationError(
  account: string,
  error: unknown,
  source?: string,
  now = Date.now(),
): void {
  safely(() => {
    const step = load(account).stage ?? "preparing"
    const code =
      error instanceof WalletError &&
      (MIGRATION_ERROR_CODES as readonly string[]).includes(error.code)
        ? error.code
        : "unknown"
    const props = { source, kind: migrationErrorKind(error), code }
    fail(account, `error:${now}`, step, props, now)
  })
}

/** The upgrade this browser started ended; its times are then dropped. */
export function reportMigrationCompleted(account: string, now = Date.now()): void {
  safely(() => {
    const funnel = load(account)
    if (funnel.startedAt === undefined) return
    save(account, undefined)
    fireEvent("migration_completed", {
      duration_ms: lap(now - funnel.startedAt),
      legs: funnel.legs,
      sessions: funnel.sessions ?? 1,
    })
  })
}

/**
 * The mount's view of the upgrade: the run record it shows, what the bell reports as waiting for
 * the user, the run's source, and whether the upgrade is done.
 */
export function useMigrationFunnel({
  account,
  record,
  stop,
  source,
  done,
}: {
  account?: string
  record: MetadataMigrationRecord | null
  stop?: string
  source?: string
  done: boolean
}): void {
  const phase = record?.phase
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (account) countMigrationSession(account)
  }, [account])
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (account && phase) reportMigrationStage(account, phase)
  }, [account, phase])
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (account && (stop === "needsAttention" || stop === "failed"))
      reportMigrationStop(account, stop, record, source)
  }, [account, stop, record, source])
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (account && done) reportMigrationCompleted(account)
  }, [account, done])
}
