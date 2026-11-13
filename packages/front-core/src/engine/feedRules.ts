/**
 * The rules the activity feed and its detail sheets read off one record, with every clock passed
 * in. They name an action, never its words.
 */
import { formatUnits, type Hex } from "viem"
import { REGISTRATION_SCHEDULE_DEFAULTS } from "@obsidion/core/constants"
import type { UpgradeBatchItem } from "../core/migration/upgradeActivity"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import { withdrawalAmounts } from "../core/services/bridge/withdrawalAmounts"
import {
  canRecoverSwap,
  canSelfExecuteSwap,
  canSelfFinalizeWithdrawal,
  SWAP_STUCK_THRESHOLD_MS,
} from "../core/services/bridge/withdrawalPhases"
import {
  isAwaitingSweep,
  sipaSweepAllowed,
  type SipaProcessingState,
} from "../core/services/deposits/sipaProcessing"
import { isStuckSweep } from "../core/services/deposits/sipaStuck"
import {
  isAccountMoveSipa,
  isSettledSipaPhase,
  isUnfundedSipaDeposit,
  type SIPADepositPhase,
  type SipaDeposit,
} from "./sipaDeposits"
import { sipaPaymentIndex } from "../core/services/deposits/sipaCredits"
import type { PendingRegistrationRecord } from "./registrationRecord"
import { recoveryState, type RecoveryState } from "../core/rotation/backupRotationFlow"
import type { BackupFundingSplit } from "./backupAddQuote"
import type {
  BackupRotationPhase,
  BackupRotationPlan,
  BackupRotationRecord,
} from "./backupRotations"
import type { MoveState } from "./moveState"
import type { MoveRecord } from "./moveTransition"
import type { TokenTransaction, Transaction } from "../types/transactions"

/**
 * A transfer from a rotated wallet's previous account: the wallet moving its own funds, which
 * arrived earlier under their own row, so neither the feed nor the bell lists it. A device that
 * scanned the previous account past the move before it knew the wallet moved filed that leg as a
 * send to `account`, the session's.
 */
export function isMoveFromPrevious(
  tx: Transaction,
  previousAccount?: string,
  account?: string,
): boolean {
  if (!previousAccount) return false
  const { senderL2Address, recipientL2Address } = tx as TokenTransaction
  if (senderL2Address?.toLowerCase() !== previousAccount.toLowerCase()) return false
  if (tx.action === "receive") return true
  return (
    tx.action === "send" && !!account && recipientL2Address?.toLowerCase() === account.toLowerCase()
  )
}

/**
 * A transfer a rotated wallet's previous account received from someone else. Activity lists it,
 * but the funds stay off the balance until a move, so the bell leaves it out.
 */
export function isReceiveAtPrevious(tx: Transaction, previousAccount?: string): boolean {
  if (!previousAccount || tx.action !== "receive") return false
  const { recipientL2Address } = tx as TokenTransaction
  return recipientL2Address?.toLowerCase() === previousAccount.toLowerCase()
}

/** A deposit to a rotated wallet's previous account. */
export function isDepositToPrevious(
  record: Pick<SipaDeposit, "recipientL2Address">,
  previousAccount?: string,
): boolean {
  return (
    !!previousAccount && record.recipientL2Address?.toLowerCase() === previousAccount.toLowerCase()
  )
}

/**
 * A deposit still on its way to a rotated wallet's previous account: the feed leaves it out until
 * it lands, because only the Passkeys panel's check claims it and moves it on. One with an exit
 * stays listed, since its row offers that exit: the sweep of a stuck one, or an L1 recovery.
 */
export function isWaitingAtPrevious(
  record: SipaDeposit,
  previousAccount: string | undefined,
  offer: DepositOffer | null,
): boolean {
  return (
    isDepositToPrevious(record, previousAccount) &&
    !isSettledSipaPhase(record.phase) &&
    record.phase !== "recoverable" &&
    !offer
  )
}

export type BridgeActivityItem =
  /**
   * `processing` is set while the deposit waits for a sweep and the observer explains why.
   * `payment` is set on a past payment split out of its address's record: its sweep's inbox index.
   */
  | {
      kind: "bridge.sipaDeposit"
      record: SipaDeposit
      processing?: SipaProcessingState
      payment?: string
    }
  | { kind: "bridge.withdrawal"; record: WithdrawalRecord }

/** A refund batch of an upgrade: its exit from the old version, paired with its arrival by recipient. */
export type UpgradeActivityItem = { kind: "upgrade.batch"; batch: UpgradeBatchItem }

export type ActivityItem = BridgeActivityItem | UpgradeActivityItem

export function itemStartTime(item: ActivityItem): number {
  return "record" in item ? item.record.startTime : item.batch.startTime
}

/**
 * A SIPA this wallet funded with its own burn (a paylink-paid registration) reads as one story:
 * the withdrawal row. The deposit record stays off the feed only while it needs nothing from the
 * user; a failed or recoverable deposit, a sweep that has stalled, or one whose funding burn
 * failed, surfaces so its error and recovery actions are reachable. The hidden record still drives
 * the claim in the background.
 */
export function hiddenBehindOwnWithdrawal(
  record: SipaDeposit,
  withdrawals: readonly WithdrawalRecord[],
  now: number,
): boolean {
  // A stopped backup add's funding row shows its recovery, which the Passkeys panel runs.
  const surfaces = record.phase === "failed" || record.phase === "recoverable"
  if (surfaces && !isStoppedBackupDeposit(record)) return false
  // A backup passkey's sweep can wait far past the stuck clock, and its row offers no exit.
  if (isStuckSweep(record, now) && !isAccountMoveSipa(record)) return false
  const sipa = record.sipaAddress.toLowerCase()
  // A migration's arrival is a row of its own: the move is two legs, and the arrival ends it.
  const funding = withdrawals.filter(
    (w) => w.recipient.toLowerCase() === sipa && w.intent !== "migration",
  )
  return funding.length > 0 && funding.some((w) => w.phase !== "failed")
}

/** No sweep can move a `recoverable` deposit, and a `recovered` one went back out on L1. */
export function neverCreditsL2(phase: SIPADepositPhase): boolean {
  return phase === "recoverable" || phase === "recovered"
}

/** Why a record offers the exit: `unsweepable` can never be swept, `stuck` still can. */
export type RecoveryReason = "unsweepable" | "stuck" | "registration-quote" | "stranded"

/**
 * Whether `record` offers the recovery exit, and on which grounds. The note's message secret is
 * half the recovery key, so a record discovered without one cannot sign at all.
 */
export function recoveryReasonFor(
  record: Pick<
    SipaDeposit,
    "phase" | "messageSecret" | "startTime" | "sweepTxHash" | "republishAskedAt"
  >,
  now: number,
): RecoveryReason | null {
  if (!record.messageSecret) return null
  if (record.phase === "recoverable") return "unsweepable"
  return isStuckSweep(record, now) ? "stuck" : null
}

/**
 * Whether the user may sweep a stuck deposit themselves: the CREATE2 address binds the two derived
 * fields, which a record created before discovery may not have yet.
 */
export function canSelfSweep(
  record: Pick<
    SipaDeposit,
    | "phase"
    | "startTime"
    | "sweepTxHash"
    | "republishAskedAt"
    | "recipientHash"
    | "recoveryAddress"
    | "origin"
  >,
  now: number,
): boolean {
  return (
    isStuckSweep(record, now) &&
    !!record.recipientHash &&
    !!(record.recoveryAddress || record.origin)
  )
}

export type RegistrationRef = Pick<
  PendingRegistrationRecord,
  "sipaAddress" | "tag" | "phase" | "sweptAt" | "sweepTxHash" | "fundedAt"
>

/** This wallet's registrations, live and replaced, and its own handle. */
export interface Registrations {
  records: readonly RegistrationRef[]
  handle?: string
}

/** A registration deposit the user can push through by hand: pending, and not already swept. */
export function canManualRegistrationSweep(
  record: Pick<PendingRegistrationRecord, "phase" | "sweptAt" | "sweepTxHash">,
): boolean {
  return (
    (record.phase === "awaiting_deposit" || record.phase === "funded") &&
    record.sweptAt === undefined &&
    record.sweepTxHash === undefined
  )
}

export function registrationFor(
  registrations: Registrations,
  sipaAddress: string,
): RegistrationRef | undefined {
  const needle = sipaAddress.toLowerCase()
  return registrations.records.find((r) => r.sipaAddress.toLowerCase() === needle)
}

/**
 * The tag a registration SIPA registered. One discovered from the note on another device has no
 * record, but its intent says so, and the name it registered is this wallet's own.
 */
export function registrationTagForSipa(
  registrations: Registrations,
  sipaAddress: string,
  deposit?: Pick<SipaDeposit, "intent">,
): string | undefined {
  const pending = registrationFor(registrations, sipaAddress)
  if (pending) return pending.tag
  return deposit?.intent === "registration" ? registrations.handle : undefined
}

/**
 * The tag a deposit row wears: none once the deposit went back and the registration waits for
 * payment again, so the returned funds and the registration are two rows.
 */
export function registrationTagForDeposit(
  registrations: Registrations,
  deposit: Pick<SipaDeposit, "sipaAddress" | "intent" | "phase">,
): string | undefined {
  const pending = registrationFor(registrations, deposit.sipaAddress)
  const refunded =
    !!pending &&
    deposit.phase === "recovered" &&
    pending.phase === "awaiting_deposit" &&
    pending.fundedAt === undefined
  return refunded ? undefined : registrationTagForSipa(registrations, deposit.sipaAddress, deposit)
}

export interface DepositOffer {
  reason: RecoveryReason | null
  /** The sheet offers the sweep. */
  canSweep: boolean
  /** A sweep could land but for capacity: an open sheet offers it once a read clears that. */
  sweepable: boolean
  waiting: boolean
  action: "sweep" | "recover"
}

export interface DepositContext {
  processing?: SipaProcessingState
  /** The registration behind the address, when it is one of this wallet's. */
  registration?: RegistrationRef
  now: number
}

/**
 * The exit a deposit row offers. A sweep may still land on a stuck deposit, so it stays pending;
 * one no sweep can move is a state of its own. An unfunded address offers neither, nor does a
 * backup passkey's: its sweep can wait far past the stuck clock, so a Recover here could cancel a
 * healthy rotation, and its panel recovers the funding once the flow finds it stranded. A
 * registration-backed deposit follows the registration's own gate on the stuck clock. A confirmed
 * capacity blocker withholds the sweep, never the recovery.
 */
export function depositExitOffer(
  record: SipaDeposit,
  { processing, registration, now }: DepositContext,
): DepositOffer | null {
  if (isUnfundedSipaDeposit(record) || isAccountMoveSipa(record)) return null
  const reason = recoveryReasonFor(record, now)
  const sweepable = registration
    ? isStuckSweep(record, now) && canManualRegistrationSweep(registration)
    : canSelfSweep(record, now)
  const canSweep = sweepable && sipaSweepAllowed(processing)
  if (!reason && !canSweep) return null
  const waiting = reason === "stuck" || sweepable
  return { reason, canSweep, sweepable, waiting, action: canSweep ? "sweep" : "recover" }
}

/**
 * The detail sheet's offer: the row's clocked offer, else a manual sweep for funds still at the
 * address with no sweep seen. Opening the detail is the "act now" signal, so the sheet never makes
 * the user wait out the row's stuck clock.
 */
export function depositDetailOffer(
  record: SipaDeposit,
  context: DepositContext,
): DepositOffer | null {
  const clocked = depositExitOffer(record, context)
  if (clocked) return clocked
  if (!isAwaitingSweep(record) || isAccountMoveSipa(record)) return null
  if (!record.recipientHash || (!record.recoveryAddress && !record.origin)) return null
  if (context.registration && !canManualRegistrationSweep(context.registration)) return null
  if (!sipaSweepAllowed(context.processing)) return null
  return { reason: null, canSweep: true, sweepable: true, waiting: true, action: "sweep" }
}

/** Why a swap record offers an exit: `unswappable` can never fill, `stuck` still can. */
export type SwapExitReason = "unswappable" | "stuck"

export function swapExitReasonFor(record: WithdrawalRecord, now: number): SwapExitReason | null {
  if (canRecoverSwap(record)) return "unswappable"
  return canSelfExecuteSwap(record, now) ? "stuck" : null
}

/** The exit a withdrawal offers: finalize a stalled release, else the swap's run or recovery. */
export type WithdrawalExit = { kind: "finalize" } | { kind: "swap"; reason: SwapExitReason }

export function withdrawalExit(record: WithdrawalRecord, now: number): WithdrawalExit | undefined {
  if (canSelfFinalizeWithdrawal(record, now)) return { kind: "finalize" }
  const reason = swapExitReasonFor(record, now)
  return reason ? { kind: "swap", reason } : undefined
}

/** Phases before the sweep runs the change: a funding's hold comes back once it does. */
const BEFORE_SWEEP: readonly BackupRotationPhase[] = ["created", "signed", "published", "funded"]

/**
 * Phases past the account change, with the key on Ethereum. Money parked over them is extra, which
 * the Passkeys card reports on its own, so the funding keeps the tracker's status.
 */
const PAST_ACCOUNT_CHANGE: readonly BackupRotationPhase[] = [
  "swept",
  "installed",
  "rerooted",
  "moved",
  "done",
]

export interface FundingRecovery {
  /** `unread` while this device's attempts are not read: whether the funding stopped is not known. */
  state: RecoveryState | "unread"
  /** What reached the deposit address and went back, base units; set once recovered. */
  deposited?: string
  recoveryTxHash?: Hex
}

/** Whether a sweep ran at the address: for a backup passkey's, the account change ran. */
const swept = (deposit: SipaDeposit) =>
  !!deposit.sweepTxHash || !!deposit.inboxIndex || !!deposit.claimedInboxIndexes?.length

/** A backup passkey's deposit address that will never run the change: the add stopped. */
export const isStoppedBackupDeposit = (deposit: SipaDeposit) =>
  isAccountMoveSipa(deposit) &&
  !swept(deposit) &&
  (neverCreditsL2(deposit.phase) || deposit.phase === "failed")

/** A backup passkey's deposit address that was swept: the add ran. */
export const isAddedBackupDeposit = (deposit: SipaDeposit) =>
  isAccountMoveSipa(deposit) && swept(deposit)

/** This device's attempt holding the funding, once the attempts are read. */
const attemptOf = (
  record: WithdrawalRecord,
  rotations: readonly BackupRotationRecord[] | "unread",
) =>
  rotations === "unread"
    ? undefined
    : rotations.find((r) => r.fundings.some((f) => f.localId === record.localId))

/**
 * Whether a backup passkey funding's add finished: the burn landed and its attempt is done, or, with
 * the attempts read and none here, its deposit address was swept. The key is on Ethereum from the
 * sweep, but the user still has the final approval to give, so the row says added only once that
 * is done. Unread attempts may hold one still waiting on it.
 */
export function backupAdded(
  record: WithdrawalRecord,
  rotations: readonly BackupRotationRecord[] | "unread",
  deposit: SipaDeposit | undefined,
): boolean {
  if (withdrawalIntent(record, deposit) !== "backup" || record.phase !== "done") return false
  if (rotations === "unread") return false
  const rotation = attemptOf(record, rotations)
  if (!rotation) return !!deposit && swept(deposit)
  const phase = rotation.phase === "attention" ? rotation.suspended : rotation.phase
  return phase === "done"
}

/**
 * A paid backup passkey funding whose attempt stopped without adding the backup: its money waits
 * at the deposit address, so the row reads the rotation's recovery instead of Paid. The Passkeys
 * panel runs the recovery; the row offers none, so it cannot race a healthy rotation.
 */
export function fundingRecovery(
  record: WithdrawalRecord,
  rotations: readonly BackupRotationRecord[] | "unread",
  deposit: SipaDeposit | undefined,
): FundingRecovery | undefined {
  if (withdrawalIntent(record, deposit) !== "backup" || record.phase !== "done") return undefined
  const rotation = attemptOf(record, rotations)
  if (rotation) {
    const { suspended, plan, recovery, recovered } = rotation
    if (suspended && PAST_ACCOUNT_CHANGE.includes(suspended)) return undefined
    // An attempt ends at `recovered` only once none of its fundings can still land, so money parked
    // over it later is not this funding's: its recovery is the one that ended the attempt.
    if (suspended === "recovered") {
      return {
        state: "recovered",
        deposited: plan?.deposited,
        ...(recovered ? { recoveryTxHash: recovered.txHash } : {}),
      }
    }
    const state = recoveryState(rotation)
    if (!state) return undefined
    // An attempt that ended without `recovered` kept its recovery in `recovery`.
    const tx = state === "recovered" ? recovered ?? recovery : recovery
    return {
      state,
      ...(state === "recovered" && plan?.deposited ? { deposited: plan.deposited } : {}),
      ...(tx ? { recoveryTxHash: tx.txHash } : {}),
    }
  }
  // The deposit address outlives the attempt's record, which the Recovered card's Done removes. A
  // swept address ran the change, so nothing waits on a recovery; an unread attempt may still wait
  // on its final approval.
  if (deposit && swept(deposit)) return rotations === "unread" ? { state: "unread" } : undefined
  if (deposit?.recoveryTxHash) {
    // With the attempts read and none holding the funding, its attempt ended at `recovered`.
    const final = deposit.phase === "recovered" || rotations !== "unread"
    return { state: final ? "recovered" : "sent", recoveryTxHash: deposit.recoveryTxHash }
  }
  return rotations === "unread" ? { state: "unread" } : undefined
}

/** The fee fields a migration's withdrawal record carries, base units as strings. */
export type MigrationFeeFields = Required<
  Pick<WithdrawalRecord, "relayerTip" | "arrivalFee" | "withdrawalFee">
>

export interface MigrationAmounts {
  /** What leaves before it reaches the new balance: the exit's fee, then the arrival's. */
  exitFeeDisplay: string
  arrivalFeeDisplay: string
  /** What the new balance receives, before any subsidy. */
  netAtomic: bigint
  netDisplay: string
}

/** Undefined while any fee is unknown: no figure beats a wrong one. */
export function migrationAmounts(
  record: Pick<WithdrawalRecord, "amount" | "rawAmount" | "proverTip" | "tokenDecimals"> &
    Partial<MigrationFeeFields>,
): MigrationAmounts | undefined {
  if (record.arrivalFee == null) return undefined
  const exit = withdrawalAmounts(record)
  if (!exit.feeKnown) return undefined
  const arrivalFee = BigInt(record.arrivalFee)
  const netAtomic = exit.netAtomic > arrivalFee ? exit.netAtomic - arrivalFee : 0n
  return {
    exitFeeDisplay: exit.feeDisplay,
    arrivalFeeDisplay: formatUnits(arrivalFee, record.tokenDecimals),
    netAtomic,
    netDisplay: formatUnits(netAtomic, record.tokenDecimals),
  }
}

/**
 * What a burn paid for. A burn rebuilt from chain names no intent, so one to a backup passkey's
 * deposit address reads as the add's funding: no other burn pays that address.
 */
export function withdrawalIntent(
  record: Pick<WithdrawalRecord, "intent">,
  deposit: Pick<SipaDeposit, "intent"> | undefined,
): WithdrawalRecord["intent"] {
  return record.intent ?? (deposit && isAccountMoveSipa(deposit) ? "backup" : undefined)
}

/** A backup passkey funding split into what the add costs and the hold sent on top; base units. */
export interface BackupFee {
  amount: bigint
  hold: bigint
  /** The hold is back in the balance. */
  returned: boolean
}

/**
 * What a backup passkey funding costs, apart from its hold. The deposit address credits the hold to
 * the new account once the add runs, on a deposit the feed hides as the account's own move, so the
 * funding's gross overstates the cost. The hold is the attempt's planned credit until the claimed
 * sweep says what came back. Undefined for a funding that failed or stopped, while neither figure
 * is known, and when the sweep took other money with this funding's, since a shared credit cannot
 * be split by payment.
 */
export function backupFee(
  record: WithdrawalRecord,
  rotations: readonly BackupRotationRecord[] | "unread",
  deposit: SipaDeposit | undefined,
): BackupFee | undefined {
  if (withdrawalIntent(record, deposit) !== "backup" || record.phase === "failed") return undefined
  if (fundingRecovery(record, rotations, deposit)) return undefined
  const released = withdrawalAmounts(record)
  const sent = released.grossAtomic
  // The claimed sweep keeps the credit's figures: money paid to the address later rewrites the
  // record's own.
  const sweep =
    record.phase === "done" && deposit && isAccountMoveSipa(deposit)
      ? deposit.sweeps?.[0]
      : undefined
  if (sweep?.fee != null) {
    const returned = BigInt(sweep.netAmount)
    // Other money paid to the address before the sweep would read as returned.
    if (!released.feeKnown || returned + BigInt(sweep.fee) !== released.netAtomic) return undefined
    return { amount: sent - returned, hold: returned, returned: true }
  }
  const attempt = attemptOf(record, rotations)
  if (!attempt?.plan) return undefined
  const phase = attempt.phase === "attention" ? attempt.suspended : attempt.phase
  const awaiting = !!phase && BEFORE_SWEEP.includes(phase) && attempt.attention !== "stranded"
  // A change that ran without this funding, or one parked off its sweep, leaves its money at the
  // address to recover.
  if (!attempt.sweep && !awaiting) return undefined
  // The sweep's credit can include other money paid to the address, which only the claim splits.
  const hold = BigInt(attempt.plan.credited)
  return sent > hold ? { amount: sent - hold, hold, returned: false } : undefined
}

/**
 * Whether the attempt a backup passkey funding paid is still running, so the Passkeys sheet shows
 * its progress. A stopped one's funding reads its recovery instead.
 */
export function backupAddRunning(
  record: WithdrawalRecord,
  rotations: readonly BackupRotationRecord[] | "unread",
  deposit: SipaDeposit | undefined,
): boolean {
  if (withdrawalIntent(record, deposit) !== "backup" || record.phase === "failed") return false
  const rotation = attemptOf(record, rotations)
  if (!rotation || fundingRecovery(record, rotations, deposit)) return false
  const phase = rotation.phase === "attention" ? rotation.suspended : rotation.phase
  return phase !== "done" && phase !== "recovered"
}

/** The Fund step's figures, priced from the plan before anything is sent; base units. */
export interface BackupFundingQuote extends BackupFundingSplit {
  /** One figure for a plan saved without what reaches the deposit address. */
  fees: bigint | { withdrawal: bigint; accountChange: bigint }
}

export function backupFundingQuote(
  plan: Pick<BackupRotationPlan, "fundingAmount" | "deposited" | "credited">,
): BackupFundingQuote {
  const sent = BigInt(plan.fundingAmount)
  const credited = BigInt(plan.credited)
  if (plan.deposited === undefined) return { sent, fees: sent - credited, credited }
  const deposited = BigInt(plan.deposited)
  return {
    sent,
    fees: { withdrawal: sent - deposited, accountChange: deposited - credited },
    credited,
  }
}

/**
 * The exit a stalled move offers: `finalize` when no relayer has sent its release, `run` once its
 * release funded the route and nobody ran it within a swap's wait, `recover` once the relayer
 * dropped it. The run's sheet offers recovery too.
 */
export function moveExitOffer(
  item: {
    state: MoveState
    move: Pick<MoveRecord, "phase" | "releasedAt">
    burn?: WithdrawalRecord
  },
  rail: { recoverable: boolean; runnable: boolean },
  now: number,
): "finalize" | "run" | "recover" | null {
  const { burn } = item
  if (burn && canSelfFinalizeWithdrawal(burn, now)) return "finalize"
  const doneAt = burn?.phase === "done" ? burn.endTime ?? burn.startTime : undefined
  const released = burn ? doneAt : item.move.releasedAt
  if (
    rail.runnable &&
    rail.recoverable &&
    item.move.phase === "burned" &&
    released !== undefined &&
    now - released >= SWAP_STUCK_THRESHOLD_MS
  )
    return "run"
  return item.state.kind === "delayed" && item.state.dropped && rail.recoverable ? "recover" : null
}

/** What a registration's signed fee charged for the tag itself: the part above the sweep fee. */
export function tagPriceOf(record: { registrationFee?: string }): bigint {
  const fee = BigInt(record.registrationFee ?? 0)
  const sweepFee = REGISTRATION_SCHEDULE_DEFAULTS.earned_tag.fee
  return fee > sweepFee ? fee - sweepFee : 0n
}

/**
 * A deposit is dated by when the person funded it; a withdrawal by its release, the moment that
 * matters to the person.
 */
export function bridgeItemTime(item: BridgeActivityItem): number {
  if (item.kind === "bridge.sipaDeposit") return item.record.startTime
  return item.record.endTime ?? item.record.startTime
}

type DepositBridgeItem = Extract<ActivityItem, { kind: "bridge.sipaDeposit" }>

/** The inbox index of the payment a deposit row shows, once its sweep is seen. */
export const depositRowPayment = (item: { record: SipaDeposit; payment?: string }) =>
  item.payment ?? sipaPaymentIndex(item.record)

/**
 * The bridge row a notification asks to open: a deposit by its detail id, a withdrawal by its id. A
 * reorg notice carries only the tx hash: the burn's or the claim's.
 */
export function findBridgeItem(
  items: readonly ActivityItem[],
  target: { openWithdrawalId?: string; openDepositAddress?: string; openTxHash?: string },
): BridgeActivityItem | undefined {
  const { openWithdrawalId, openDepositAddress } = target
  if (openDepositAddress) return depositDetailItem(items, openDepositAddress)
  const txHash = target.openTxHash?.toLowerCase()
  if (!openWithdrawalId && !txHash) return undefined
  return items.find(
    (item): item is BridgeActivityItem =>
      item.kind === "bridge.withdrawal" &&
      (item.record.localId === openWithdrawalId ||
        (!!txHash && item.record.l2TxHash?.toLowerCase() === txHash)),
  )
}

/** A deposit row's detail id: its address, and the payment the row shows once its sweep is seen. */
export function depositDetailId(item: { record: SipaDeposit; payment?: string }): string {
  const payment = depositRowPayment(item)
  return payment ? `${item.record.sipaAddress}:${payment}` : item.record.sipaAddress
}

/**
 * The row a deposit detail shows: `address:index` picks that payment's row, whether it is split out
 * or the address's own by now; an address alone, or a payment it no longer shows, picks the
 * address's own row.
 */
export function depositDetailItem(
  items: readonly ActivityItem[],
  id: string,
): DepositBridgeItem | undefined {
  const [address, payment] = id.toLowerCase().split(":")
  const rows = items.filter(
    (item): item is DepositBridgeItem =>
      item.kind === "bridge.sipaDeposit" && item.record.sipaAddress.toLowerCase() === address,
  )
  return (
    (payment ? rows.find((item) => depositRowPayment(item) === payment) : undefined) ??
    rows.find((item) => !item.payment)
  )
}

/**
 * The detail a routed bridge row opens: a Savings move's burn its Savings detail, by the burn's id, a leg of a fresh
 * withdrawal its group, a deposit its address, and a past payment at it that payment.
 */
export function bridgeDetailTarget(
  hit: BridgeActivityItem,
): { kind: "savings" | "withdrawal"; id: string } | { kind: "deposit"; address: string } {
  if (hit.kind === "bridge.sipaDeposit")
    return { kind: "deposit", address: hit.payment ? depositDetailId(hit) : hit.record.sipaAddress }
  if (hit.record.skyMove || hit.record.vaultMove) return { kind: "savings", id: hit.record.localId }
  return { kind: "withdrawal", id: hit.record.groupId ?? hit.record.localId }
}
