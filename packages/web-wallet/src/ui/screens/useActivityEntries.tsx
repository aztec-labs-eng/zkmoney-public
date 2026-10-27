import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useActionGuard } from "../../features/actionGate"
import { isDemoMode } from "../../dev/demoFlag"
import { formatUnits } from "viem"
import {
  DEFAULT_DECIMALS,
  REGISTRATION_SCHEDULE_DEFAULTS,
  WALLET_TOKEN_SYMBOL,
} from "@obsidion/core/constants"
import type { TokenService } from "@obsidion/sdk"
import {
  ActivityListRow,
  GradientInitialAvatar,
  avatarColors,
  type StatusLabel,
} from "@obsidion/web-ds"
import {
  isAwaitingSweep,
  isFundsLegUnsent,
  WITHDRAWAL_FUNDS_UNSENT,
  ActivityFeed,
  SIPADepositStore,
  TransactionStorage,
  UpgradeActivity,
  RequestStorage,
  approvedContactTags,
  buildPaidLinkRows,
  buildRequestRows,
  canSelfFinalizeWithdrawal,
  canSelfRunSkyEscrow,
  globalEventEmitter,
  isFromNonContact,
  isSettledSipaPhase,
  isUnfundedSipaDeposit,
  sipaSweepAllowed,
  isWithdrawalDelayed,
  isWithdrawalGroupTerminal,
  onRefundInFlightChanged,
  payerForPaidLink,
  refundInFlightVersion,
  requestLinkedSipaAddresses,
  useAssetContext,
  useAztecContext,
  useCachedRecords,
  useContactsDirectory,
  withdrawalGroupAmount,
  withdrawalGroupTime,
  withdrawalGroupsOf,
  withoutPaidLinkReceives,
  withoutAnsweredRequests,
  worstWithdrawalPhase,
  WITHDRAWAL_TERMINAL_PHASES,
  type ActivityCsvSources,
  type ActivityCsvToken,
  type SavingsCsvSources,
  type ActivityItem,
  type BridgeActivityItem,
  type PaymentRequest,
  type RequestRowView,
  type SIPADepositRecord,
  type SipaProcessingState,
  type Transaction,
  type WithdrawalRecord,
  useSyncCatchingUp,
  WITHDRAWAL_PHASE_COPY,
  savingsLedger,
  type SavingsLedger,
  savingsMoveEta,
  savingsMoveOfWithdrawal,
  useSavingsPosition,
  useSavingsSource,
  useEnsName,
  type SavingsMoveRecord,
  upgradeRecipients,
  upgradeRunsOf,
  upgradeRunValue,
  type UpgradePricing,
  type UpgradeRun,
  type OldVersionRefund,
  type OldVersionWithdrawal,
} from "@obsidion/front-core"
import { ensClient } from "../../lib/ens"
import { declineRequestById } from "../../features/contacts/requestActions"
import { REMIND_TITLE, useRemind, type RemindState } from "../../features/contacts/useRemind"
import { RequestDetailModal } from "../../features/contacts/RequestDetailModal"
import { unlistedCodeRequestIds } from "../../features/receive/receiveCode"
import { DepositExitModal } from "../../features/deposit/DepositExitModal"
import {
  isStuckSweep,
  recoveryReasonFor,
  type RecoveryReason,
} from "../../features/deposit/sipaRecovery"
import { canSelfSweep } from "../../features/deposit/sipaSweep"
import { settlementDecimals, useDepositTokens } from "../../features/deposit/loadDepositFacts"
import { bridgeActivityFeed } from "../../features/deposit/sipaProcessing"
import { loadWalletIdentity } from "../../features/identity/walletIdentity"
import { usePolledChainSeconds } from "../../features/paylink/chainTime"
import {
  canManualRegistrationSweep,
  registrationRecordForSipa,
} from "../../features/onboarding/registrationSweep"
import {
  registrationTagForDeposit,
  registrationTagForSipa,
  useRegistrationDepositEntry,
} from "../../features/onboarding/useRegistrationDepositEntry"
import type { CreatorLinkAction } from "../../features/paylink/creatorLinkActions"
import { LinkRecoverModal } from "../../features/paylink/LinkRecoverModal"
import { usePaylinkDeps } from "../../features/paylink/usePaylinkDeps"
import { IncomingRequestDetailModal } from "../../features/requests/IncomingRequestDetailModal"
import { SharePaylinkModal } from "../../features/requests/SharePaylinkModal"
import { CancelRequestLinkModal } from "../../features/requests/CancelRequestLinkModal"
import { SavingsMoveDetailModal } from "../../features/savings/SavingsMoveDetailModal"
import { UpgradeBatchDetailModal } from "./UpgradeBatchDetailModal"
import { UpgradeRunDetailModal } from "./UpgradeRunDetailModal"
import { savingsFinalizeDeployment } from "../../features/savings/savingsGateway"
import {
  SavingsMoveRow,
  isSavingsMoveSettled,
  savingsMoveEntries,
} from "../../features/savings/SavingsMoveRow"
import { getSavingsMoveStore } from "../../features/savings/savingsMoveStore"
import { useNowMs, useSavingsMoveTiming } from "../../features/savings/savingsMoveTiming"
import { useWithdrawals } from "../../features/withdraw/useWithdrawals"
import {
  oldVersionRefundOffer,
  useOldVersionWithdrawals,
  withdrawalSent,
} from "../../features/withdraw/oldVersionWithdrawals"
import { l1TxUrl } from "../detailRows"
import {
  oldVersionLeftovers,
  type OldVersionLeftovers,
} from "../../features/migration/oldVersionLeftovers"
import { SwapExitModal } from "../../features/withdraw/SwapExitModal"
import { swapExitReasonFor, type SwapExitReason } from "../../features/withdraw/swapRecovery"
import { OldVersionRefundExitModal } from "../../features/withdraw/OldVersionRefundExitModal"
import { WithdrawalExitModal } from "../../features/withdraw/WithdrawalExitModal"
import { migrationAmounts } from "../../features/migration/migrationFee"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { rowTimestamp, usdFigure, shortL1Addr } from "../format"
import { writeClipboard } from "../hooks"
import { usePhoneLayout } from "../usePhoneLayout"
import { arrivingFunds, type ArrivingFunds } from "./arrivingFunds"
import { useOldVersionHoldings } from "../../features/migration/oldVersionBalance"
import { upgradeRunAccount, upgradeRunToken } from "../../features/migration/upgradeRunAccount"
import { upgradeRunTitle } from "../../features/migration/upgradeCopy"
import { contactDisplayName } from "../../features/contacts/contactsView"
import {
  buildActivityRows,
  depositRowAmount,
  depositRowStatusLabel,
  upgradeRowStatusLabel,
  depositRowSubline,
  STUCK_SUBLINE,
  isPendingActivityRow,
  linkFragmentOf,
  sipaDepositIntentRow,
  txNoteFor,
  type ActivityRowView,
  type SipaDepositIntentRow,
} from "./activityView"
import { DepositDetailModal, TagPurchaseModal } from "./DepositDetailModal"
import { FreshWithdrawalDetailModal } from "./FreshWithdrawalDetailModal"
import { TxDetailModal } from "./TxDetailModal"
import { WithdrawalDetailModal, withdrawalHeroAmount } from "./WithdrawalDetailModal"
import { paylinkRowShareUrl } from "../../features/shortLinks"

/** Feed-row wording per phase, from the shared copy table; a `done` withdrawal carries no status. */
export const WITHDRAWAL_PHASE_LABEL = Object.fromEntries(
  Object.entries(WITHDRAWAL_PHASE_COPY).map(([phase, copy]) => [phase, copy.pill]),
) as Record<WithdrawalRecord["phase"], StatusLabel | undefined>

/** One feed instance per page load, unioning SIPA deposits + withdrawals. */
function getActivityFeed(): ActivityFeed {
  return bridgeActivityFeed()
}

/**
 * The exit a deposit row offers, or null where it offers none. A sweep may still land on a stuck
 * deposit, so it stays pending and only says so in the subline; one no sweep can move is a state of
 * its own. An unfunded address offers neither. "Sweep manually" opens the two-exit sheet, "Recover"
 * the recover-only one.
 *
 * `canSweep` is whether the sheet offers the sweep. A confirmed capacity blocker withholds it
 * until a later read clears it; the deposit still waits, and recovery never depends on capacity.
 */
export function depositExitOffer(
  record: SIPADepositRecord,
  processing?: SipaProcessingState,
): {
  reason: RecoveryReason | null
  canSweep: boolean
  /** A sweep could land but for capacity: an open sheet offers it once a read clears that. */
  sweepable: boolean
  waiting: boolean
  title: string
} | null {
  if (isUnfundedSipaDeposit(record)) return null
  const reason = recoveryReasonFor(record)
  // A registration-backed deposit follows the registration's own gate on the rail's stuck clock;
  // see registrationRecordForSipa for why the plain sweep can never move one.
  const registration = registrationRecordForSipa(record.sipaAddress)
  const sweepable = registration
    ? isStuckSweep(record) && canManualRegistrationSweep(registration)
    : canSelfSweep(record)
  const canSweep = sweepable && sipaSweepAllowed(processing)
  if (!reason && !canSweep) return null
  const waiting = reason === "stuck" || sweepable
  return { reason, canSweep, sweepable, waiting, title: canSweep ? "Sweep manually" : "Recover" }
}

/**
 * The detail sheet's offer: the row's clocked offer when it exists, else a manual sweep for funds
 * still at the address with no sweep seen — opening the detail IS the "I want to act now" signal,
 * so the sheet never makes the user wait out the row's stuck clock.
 */
export function depositDetailOffer(
  record: SIPADepositRecord,
  processing?: SipaProcessingState,
): ReturnType<typeof depositExitOffer> {
  const clocked = depositExitOffer(record, processing)
  if (clocked) return clocked
  if (!isAwaitingSweep(record)) return null
  if (!record.recipientHash || (!record.recoveryAddress && !record.origin)) return null
  const registration = registrationRecordForSipa(record.sipaAddress)
  if (registration && !canManualRegistrationSweep(registration)) return null
  if (!sipaSweepAllowed(processing)) return null
  return { reason: null, canSweep: true, sweepable: true, waiting: true, title: "Sweep manually" }
}

/**
 * The exit a swap withdrawal's row offers, or null where it offers none. A stuck escrow may still be
 * run by a relayer, so it stays pending and only says so in the subline; one whose route cannot
 * fill is a state of its own. Both open the same sheet, swap first or recovery alone.
 */
export function withdrawalExitOffer(
  record: WithdrawalRecord,
  now: number = Date.now(),
): { reason: SwapExitReason; title: string } | null {
  const reason = swapExitReasonFor(record, now)
  if (!reason) return null
  return { reason, title: reason === "stuck" ? "Run swap manually" : "Recover" }
}

function WithdrawalRow({
  record,
  onCheckAgain,
  onOpen,
  exit,
}: {
  record: WithdrawalRecord
  onCheckAgain: (l2TxHash: string) => void
  onOpen: () => void
  exit?: { title: string; onStart: () => void }
}) {
  const offer = withdrawalExitOffer(record)
  const delayed = isWithdrawalDelayed(record) || offer?.reason === "stuck"
  const checkAgain = delayed && record.l2TxHash ? () => onCheckAgain(record.l2TxHash!) : undefined
  // A burn to this wallet's registration SIPA paid for its tag, not a withdrawal to a stranger; one
  // to a backup passkey's deposit address pays for the key.
  const registrationTag = registrationTagForSipa(record.recipient)
  const migration = record.intent === "migration"
  const backup = record.intent === "backup"
  const ensName = useEnsName(record.recipient, ensClient)
  return (
    <ActivityListRow
      counterparty={
        migration
          ? "Upgrade"
          : backup
          ? "Backup passkey"
          : registrationTag
          ? `@${registrationTag}`
          : record.recipientAlias ?? ensName ?? shortL1Addr(record.recipient)
      }
      counterpartyBadge={
        // In flight, the status pill says where the exit is.
        migration
          ? record.phase === "done"
            ? "Left old version"
            : undefined
          : backup
          ? "Funding"
          : registrationTag
          ? "Registration"
          : record.source === "paylink"
          ? "Paylink → Ethereum"
          : "Withdrawal"
      }
      timestamp={delayed ? STUCK_SUBLINE : rowTimestamp(record.endTime ?? record.startTime)}
      amount={`-${usdFigure(record.amount)}`}
      statusLabel={WITHDRAWAL_PHASE_LABEL[record.phase]}
      avatarIcon="wallet"
      onClick={onOpen}
      ariaLabel="Open withdrawal details"
      actions={[
        ...(checkAgain ? [{ title: "Check again", onClick: checkAgain }] : []),
        ...(exit
          ? [{ title: exit.title, actionStyle: "gradient" as const, onClick: exit.onStart }]
          : []),
      ]}
    />
  )
}

/** One upgrade: its batches and the deposits they bring, as one row until every one has arrived. */
function UpgradeRunRow({
  run,
  pricing,
  onOpen,
}: {
  run: UpgradeRun
  pricing: UpgradePricing
  onOpen: () => void
}) {
  const title = upgradeRunTitle[upgradeRunAccount(run.run)]
  const value = upgradeRunValue(run, pricing)
  const transfers = run.legs.length === 1 ? "1 transfer" : `${run.legs.length} transfers`
  return (
    <ActivityListRow
      counterparty={title}
      counterpartyBadge={run.complete ? transfers : `${run.arrived} of ${run.legs.length} arrived`}
      timestamp={rowTimestamp(run.time)}
      amount={value === undefined ? "—" : `+${usdFigure(formatUnits(value, DEFAULT_DECIMALS))}`}
      statusLabel={upgradeRowStatusLabel(run)}
      avatarIcon="wallet"
      onClick={onOpen}
      ariaLabel="Open upgrade details"
    />
  )
}

function DepositRow({
  row,
  processing,
  arriving,
  time,
  decimals,
  onOpen,
  onExit,
}: {
  /** Why the deposit still waits for its sweep, from the feed. */
  processing?: SipaProcessingState
  /**
   * A migration's arrival before its funds land. `net` is what the exit brings, display units;
   * unset while a fee is unknown, so the row shows no figure rather than a wrong one.
   */
  arriving?: { net?: string }
  /** When the row is dated; the record's own time where unset. */
  time?: number
  /** The decimals of the row the deposit settles on: the units of its record's amounts. */
  decimals?: number
  /** The deposit projected onto its intent: a plain DepositIntent, or a RegistrationIntent that
   *  keeps the `@name` identity. */
  row: SipaDepositIntentRow
  onOpen: () => void
  onExit: () => void
}) {
  const { record } = row
  const offer = depositExitOffer(record, processing)
  const subline = depositRowSubline(processing, record, !!offer?.waiting)
  const registration = row.intent === "registration" ? row : undefined
  const migration = row.intent === "migration"
  return (
    <ActivityListRow
      counterparty={registration ? `@${registration.name}` : migration ? "Upgrade" : "Deposit"}
      counterpartyBadge={
        registration
          ? "Registration"
          : migration && isSettledSipaPhase(record.phase)
          ? "Arrived"
          : undefined
      }
      timestamp={subline ?? rowTimestamp(time ?? record.startTime)}
      amount={
        arriving
          ? arriving.net
            ? `+${usdFigure(arriving.net)}`
            : ""
          : depositRowAmount(record, !!offer, decimals)
      }
      statusLabel={arriving ? "Pending" : depositRowStatusLabel(record)}
      avatarIcon="arrow-down-circle"
      onClick={onOpen}
      ariaLabel="Open deposit details"
      actions={
        offer ? [{ title: offer.title, actionStyle: "gradient" as const, onClick: onExit }] : []
      }
    />
  )
}

/** A deposit is dated by when the person funded it; the sweep and claim that settle it are plumbing.
 *  A withdrawal is dated by its release, the moment that matters to the person. */
function bridgeItemTime(item: BridgeActivityItem): number {
  if (item.kind === "bridge.sipaDeposit") return item.record.startTime
  return item.record.endTime ?? item.record.startTime
}

type SipaDepositItem = Extract<BridgeActivityItem, { kind: "bridge.sipaDeposit" }>

/** A deposit row's ID: its address, plus the token when the row is another token the address credited. */
function depositRowId(item: SipaDepositItem): string {
  return item.credit
    ? `${item.record.sipaAddress}:${item.credit.toLowerCase()}`
    : item.record.sipaAddress
}

/** The token a deposit row shows: the one it splits out, else the record's own. */
function depositRowToken(item: SipaDepositItem): string | undefined {
  return (item.credit ?? item.record.rowToken ?? item.record.tokenAddress)?.toLowerCase()
}

/**
 * The row an open deposit detail shows: `address:token` picks that token's row, whether it is split out or the
 * address's own by now; an address alone, or a token it no longer shows, picks the address's own row.
 */
function depositDetailRow(
  items: readonly ActivityItem[],
  id: string | null,
): SipaDepositItem | undefined {
  const [address, token] = id?.toLowerCase().split(":") ?? []
  const rows = items.filter(
    (item): item is SipaDepositItem =>
      item.kind === "bridge.sipaDeposit" && item.record.sipaAddress.toLowerCase() === address,
  )
  return (
    (token ? rows.find((item) => depositRowToken(item) === token) : undefined) ??
    rows.find((item) => !item.credit)
  )
}

/** What each recovery calls itself, in the words the detail sheet's button uses. */
const LINK_RECOVERY_TITLE: Record<CreatorLinkAction, string> = {
  reclaim: "Reclaim funds",
  cancel: "Cancel link",
}

/** Share sheet where the browser has one; clipboard otherwise. */
function shareLink(url: string, text: string): void {
  if (typeof navigator.share === "function") void navigator.share({ text, url }).catch(() => {})
  else void navigator.clipboard?.writeText(url).catch(() => {})
}

/**
 * An open recovery sheet, held by value: the refund advances the row out of the list under it, and a
 * sheet mid-submit must not go with it.
 */
interface LinkRecovery {
  action: CreatorLinkAction
  fragment: string
  amount: string
  createdMs: number
  untilClaimableSec?: number
  refundableUntilSec?: number
}

/** The one open exit sheet. Opening one from a detail replaces that detail rather than stacking. */
type BridgeExit =
  | {
      kind: "deposit"
      record: SIPADepositRecord
      reason: RecoveryReason | null
      canSweep: boolean
      sweepable: boolean
    }
  /** `savings`: a move out's burn, finalized on the Savings deployment and its co-signer. */
  | { kind: "withdrawal"; record: WithdrawalRecord; savings?: boolean }
  | { kind: "swap"; record: WithdrawalRecord; reason: SwapExitReason }
  | { kind: "skyEscrow"; move: SavingsMoveRecord; burn: WithdrawalRecord }
  | { kind: "oldVersion"; record: OldVersionWithdrawal; refund: OldVersionRefund }

/** Actionable pending-request row — Decline/Send incoming, Cancel/Remind to a contact, Cancel/Share on
 *  a link. Cancelling a link only drops the local row: nothing can revoke a minted link. */
export function RequestRow({
  row,
  remind,
  onDecline,
  onSend,
  onCancel,
  onRemind,
  onOpen,
  compact = false,
}: {
  row: RequestRowView
  /** No action buttons: the row opens its detail. */
  compact?: boolean
  remind: RemindState
  onDecline: (id: string) => void
  onSend: (row: RequestRowView) => void
  onCancel: (id: string) => void
  onRemind: (id: string) => void
  onOpen?: () => void
}) {
  const isLink = row.kind === "outgoingLink"
  const actions =
    row.kind === "incoming"
      ? [
          { title: "Decline", onClick: () => onDecline(row.id) },
          { title: "Send", actionStyle: "gradient" as const, onClick: () => onSend(row) },
        ]
      : row.kind === "outgoingContact"
      ? [
          { title: "Cancel", onClick: () => onCancel(row.id) },
          {
            title: REMIND_TITLE[remind],
            actionStyle: "gradient" as const,
            isLoading: remind === "sending",
            isDisabled: remind === "sent",
            onClick: () => onRemind(row.id),
          },
        ]
      : [
          { title: "Cancel", onClick: () => onCancel(row.id) },
          ...(onOpen
            ? [{ title: "Share", actionStyle: "gradient" as const, onClick: onOpen }]
            : []),
        ]
  const content = (
    <ActivityListRow
      counterparty={isLink ? "Requested via paylink" : row.counterparty}
      counterpartyBadge={isLink ? undefined : "Requested"}
      timestamp={rowTimestamp(row.timestampMs)}
      amount={row.amount}
      statusLabel={row.statusLabel}
      avatarIcon={row.kind === "outgoingLink" ? "link" : undefined}
      avatar={
        row.contactTag ? (
          <GradientInitialAvatar
            name={row.counterparty.replace(/^@/, "")}
            colors={avatarColors(row.contactTag)}
            size={44}
          />
        ) : undefined
      }
      actions={compact ? [] : actions}
      onClick={onOpen}
      ariaLabel={onOpen ? "Open request details" : undefined}
    />
  )
  return content
}

export interface ActivityEntry {
  id: string
  ts: number
  direction: "in" | "out"
  pending: boolean
  /** A pending incoming contact request — Home lifts these out of the list into their own slot. */
  incomingRequest?: boolean
  /** A request nobody has paid yet: Pending only, never Sent or Received, until money moves. */
  unpaidRequest?: boolean
  node: ReactNode
  /** An unpaid request as a plain row that opens its detail, for the Requests list. */
  compactNode?: ReactNode
}

export interface ActivityEntriesState {
  entries: ActivityEntry[]
  /** The Savings account's feed: its moves, as it sees them. */
  savingsEntries: ActivityEntry[]
  /** True once the move store has loaded, so an empty Savings feed is known to be empty. */
  savingsHydrated: boolean
  /** What the Savings moves put in and took out; undefined until the moves are read. */
  savingsLedger: SavingsLedger | undefined
  /** Funds on their way into Main and Savings, which their balances show before they land. */
  arriving: ArrivingFunds
  /** What old versions still hold that no balance here shows. */
  oldVersionLeft: OldVersionLeftovers
  /** The upgrade's deposit addresses are read, so `arriving` counts none of them. */
  upgradesLoaded: boolean
  /** True once every source has served its last-known state from storage. */
  hydrated: boolean
  /** The contacts could not be read, so incoming requests are hidden. The directory retries. */
  requestsUnavailable: boolean
  detailModals: ReactNode
  /** The stored records behind the feed, for the accounting export; undefined until the Main token's metadata is read. */
  csvSources?: ActivityCsvSources
  /** The Savings feed's moves and their burns, for its export; undefined like `csvSources`. */
  savingsCsvSources?: SavingsCsvSources
}

/**
 * The unified activity feed, newest first: L2 transactions (contact-enriched)
 * interleaved with SIPA deposits and L2→L1 withdrawals. Mounting also arms the
 * withdrawal chain watcher via useWithdrawals, so in-flight records left by a
 * closed tab resume advancing wherever the feed renders. `hydrated` gates the
 * list and empty state: until every persisted source has been read back and a
 * fresh device's first chain scan has finished, the feed shows a skeleton
 * instead of rows landing one by one.
 *
 * Every modal a row can open lives here so Home and Activity share one open/close path instead of
 * duplicating the state plumbing. That includes the deposit and withdrawal exit sheets, which is
 * what lets a submitted exit outlive the row it came from. A verified receive that fulfills an
 * outgoing link is omitted — the paid-link row is the canonical incoming entry; the detail modal's
 * Paid by row comes from `payerForPaidLink`.
 */
/**
 * The notification text a detail opened with. `staleOn` marks a failure alert: the row status that
 * outdates it, and a withdrawal outdates it in every phase but failed.
 */
export type DetailNotice = { text: string; staleOn?: "success" }

export function detailNoticeFor(
  notice: DetailNotice | undefined,
  row: Pick<ActivityRowView, "status"> | Pick<WithdrawalRecord, "phase">,
): string | undefined {
  const stale = "phase" in row ? row.phase !== "failed" : row.status === notice?.staleOn
  return notice?.staleOn && stale ? undefined : notice?.text
}

/**
 * Bridge row a notification tap asks to open. Producers lowercase the SIPA address; records keep it
 * checksummed. A reorg notice carries only the tx hash, which the reorg monitor takes from the
 * withdrawal's burn tx or the deposit's claim tx.
 */
export function findBridgeItem(
  items: ActivityItem[],
  state: { openWithdrawalId?: string; openDepositAddress?: string; openTxHash?: string },
): BridgeActivityItem | undefined {
  const { openWithdrawalId, openDepositAddress } = state
  const deposit = openDepositAddress?.toLowerCase()
  const txHash = state.openTxHash?.toLowerCase()
  if (!openWithdrawalId && !deposit && !txHash) return undefined
  return items.find(
    (item): item is BridgeActivityItem =>
      (item.kind === "bridge.withdrawal" &&
        (item.record.localId === openWithdrawalId ||
          (!!txHash && item.record.l2TxHash?.toLowerCase() === txHash))) ||
      (item.kind === "bridge.sipaDeposit" &&
        !item.credit &&
        (item.record.sipaAddress.toLowerCase() === deposit ||
          (!!txHash && item.record.claimTxHash?.toLowerCase() === txHash))),
  )
}

/**
 * The detail a routed bridge row opens: a Savings move's burn opens the Savings detail its row
 * opens, a leg of a fresh withdrawal its group, a deposit its address.
 */
export function bridgeDetailTarget(
  hit: BridgeActivityItem,
): { savings: string } | { withdrawal: string } | { deposit: string } {
  if (hit.kind === "bridge.sipaDeposit") return { deposit: hit.record.sipaAddress }
  if (hit.record.skyMove) return { savings: hit.record.localId }
  return { withdrawal: hit.record.groupId ?? hit.record.localId }
}

/**
 * The exit a stalled move offers: `finalize` when no relayer has sent its release, `run` when the
 * release paid its escrow and nobody has run it since; null while the move is on its way.
 */
export function savingsMoveExitOffer(
  move: SavingsMoveRecord,
  burn: WithdrawalRecord,
  now?: number,
): "finalize" | "run" | null {
  if (canSelfFinalizeWithdrawal(burn, now)) return "finalize"
  return canSelfRunSkyEscrow(move, burn, now) ? "run" : null
}

/** What a registration's signed fee charged for the tag itself: the part above the relayer's sweep fee. */
function tagPriceOf(record: { registrationFee?: string }): bigint {
  const fee = BigInt(record.registrationFee ?? 0)
  const sweepFee = REGISTRATION_SCHEDULE_DEFAULTS.earned_tag.fee
  return fee > sweepFee ? fee - sweepFee : 0n
}

/** Demo mode boots no token service; its fixtures are in the wallet token. */
const DEMO_WALLET_TOKEN: ActivityCsvToken = {
  symbol: WALLET_TOKEN_SYMBOL,
  decimals: DEFAULT_DECIMALS,
}

/** How long a failed read of the Main token's metadata waits before reading again. */
const WALLET_TOKEN_RETRY_MS = 10_000

/** The Main token's symbol and decimals, which the exports report in. A failed read is retried. */
function useWalletToken(
  tokenService: Pick<TokenService, "fetchTokenInformation"> | null | undefined,
): ActivityCsvToken | undefined {
  const [token, setToken] = useState<ActivityCsvToken>()
  useEffect(() => {
    setToken(undefined)
    if (!tokenService) return
    let live = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const read = () =>
      tokenService.fetchTokenInformation().then(
        ({ symbol, decimals }) => live && setToken({ symbol, decimals }),
        (err: unknown) => {
          console.warn("[activity] token metadata unavailable:", err)
          if (live) retry = setTimeout(read, WALLET_TOKEN_RETRY_MS)
        },
      )
    void read()
    return () => {
      live = false
      clearTimeout(retry)
    }
  }, [tokenService])
  return token
}

export function useActivityEntries(): ActivityEntriesState {
  const navigate = useNavigate()
  const directory = useContactsDirectory()
  const { tokenService, activeTokenAddress, balanceReadAt } = useAssetContext()
  const { obsidionWallet } = useAztecContext()
  const walletToken =
    useWalletToken(tokenService) ??
    (import.meta.env.DEV && isDemoMode() ? DEMO_WALLET_TOKEN : undefined)
  const depositTokens = useDepositTokens()
  const { records: withdrawalRecords, checkAgain, hydrated: withdrawalsHydrated } = useWithdrawals()
  const { records: oldVersionWithdrawals } = useOldVersionWithdrawals()
  const { records: savingsMoves, hydrated: savingsHydrated } = useCachedRecords(
    useMemo(getSavingsMoveStore, []),
  )
  const savingsSource = useSavingsSource()
  const savingsPosition = useSavingsPosition().position
  const savingsSharePrice = savingsPosition?.sharePrice
  const upgradePricing: UpgradePricing = {
    mainToken: depositTokens?.settlement.address,
    savingsToken: savingsSource?.assetAddress,
    sharePrice: savingsSharePrice,
    runToken: (run) =>
      upgradeRunToken(run, {
        main: depositTokens?.settlement.address,
        savings: savingsSource?.assetAddress,
      }),
  }
  const savingsTiming = useSavingsMoveTiming()
  const nowMs = useNowMs()
  const savingsEtaFor = useCallback(
    (move: SavingsMoveRecord, burn?: WithdrawalRecord) =>
      savingsTiming ? savingsMoveEta(move, burn, savingsTiming, nowMs) : undefined,
    [savingsTiming, nowMs],
  )
  // A move's detail, by its burn's record id; held by id so the settle pass advances it in place.
  const [savingsDetailId, setSavingsDetailId] = useState<string | null>(null)
  const settleSavings = useCallback(
    () =>
      void savingsSource?.settle().catch((err) => console.warn("[savings] settle failed:", err)),
    [savingsSource],
  )
  const paylinkDeps = usePaylinkDeps()
  const feed = useMemo(getActivityFeed, [])
  const registrationDeposit = useRegistrationDepositEntry()
  const { records: depositRecords, hydrated: depositsHydrated } = useCachedRecords(
    useMemo(() => SIPADepositStore.get(webStorage), []),
  )
  const oldHoldings = useOldVersionHoldings()
  const upgrades = UpgradeActivity.get(webStorage)
  const upgradesHydrated = useSyncExternalStore(
    useCallback((listener: () => void) => upgrades.onChanged(listener), [upgrades]),
    () => upgrades.loaded(),
  )
  const [items, setItems] = useState<ActivityItem[]>(() => feed.list())
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [transactionsHydrated, setTransactionsHydrated] = useState(false)
  const catchingUp = useSyncCatchingUp()
  const [requests, setRequests] = useState<PaymentRequest[]>([])
  const [requestsHydrated, setRequestsHydrated] = useState(false)
  const [detail, setDetail] = useState<ActivityRowView | null>(null)
  // A record's localId or a group's id (disjoint: `wdraw_...` against 0x hex). Held by id, not by
  // value: the tracker advances the record while the sheet is open and the ladder has to follow it.
  const [withdrawalDetailId, setWithdrawalDetailId] = useState<string | null>(null)
  const [upgradeDetailId, setUpgradeDetailId] = useState<string | null>(null)
  const [upgradeRunId, setUpgradeRunId] = useState<string | null>(null)
  // The upgrade whose sheet opened the transfer detail on screen, which Back returns to.
  const [upgradeBackRun, setUpgradeBackRun] = useState<string | null>(null)
  const [depositDetailId, setDepositDetailId] = useState<string | null>(null)
  const [tagDetailId, setTagDetailId] = useState<string | null>(null)
  const [requestLinkDetail, setRequestLinkDetail] = useState<PaymentRequest | null>(null)
  const [cancelRequestId, setCancelRequestId] = useState<string | null>(null)
  const [cancelLinkId, setCancelLinkId] = useState<string | null>(null)
  const [sentDetailId, setSentDetailId] = useState<string | null>(null)
  const [incomingDetailId, setIncomingDetailId] = useState<string | null>(null)
  // Held by value, unlike the details above: a submitted exit advances its record straight out of
  // the filtered list, and a sheet mid-submit must not go with it.
  const [exit, setExit] = useState<BridgeExit | null>(null)
  const [linkRecovery, setLinkRecovery] = useState<LinkRecovery | null>(null)
  // Rows offer Cancel link during grace and Reclaim funds after expiry; a mounted list must flip as chain
  // time crosses those boundaries, and offers neither until the tip has been read.
  const chainNow = usePolledChainSeconds(paylinkDeps?.wallet.node)

  // Read again once subscribed: a source can load between the first render and this effect.
  useEffect(() => {
    const unsubscribe = feed.onChanged(setItems)
    setItems(feed.list())
    return unsubscribe
  }, [feed])

  // A just-created paylink or a tapped notification lands here with its row key in router state;
  // open its detail once the row exists, then clear the state so a back/refresh doesn't reopen it.
  const routerState = useLocation().state as {
    openTxHash?: string
    /** A creator paylink row by its claim URL — the key a row has before its tx hash. */
    openPaylink?: string
    openWithdrawalId?: string
    openDepositAddress?: string
    /** An upgrade's run key: its row's sheet. */
    openUpgradeRun?: string
    /** A request link's id: its share sheet. */
    openRequestId?: string
    /** Full text of the notification that opened the detail. */
    notice?: string
    /** The row status that makes the notice stale. */
    noticeStaleOn?: "success"
  } | null
  const routerNotice = routerState?.notice
  const routerNoticeStaleOn = routerState?.noticeStaleOn
  // Set only when a notification opens a detail; every row tap clears it.
  const [notice, setNotice] = useState<DetailNotice>()
  // Desktop has no useful native share sheet, so a sent link's row copies instead; the id keeps the
  // "Copied!" flash on the one row that was clicked.
  const phone = usePhoneLayout()
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  const copyLink = useCallback(async (id: string, url: string) => {
    if (!(await writeClipboard(url))) return
    setCopiedLinkId(id)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopiedLinkId(null), 2000)
  }, [])
  const openTxHash = routerState?.openTxHash
  const openPaylink = routerState?.openPaylink
  const openWithdrawalId = routerState?.openWithdrawalId
  const openDepositAddress = routerState?.openDepositAddress

  useEffect(() => {
    const storage = webStorage
    const load = () =>
      TransactionStorage.get(storage)
        .getTransactions()
        .then(setTransactions)
        .catch(() => setTransactions([]))
        .finally(() => setTransactionsHydrated(true))
    void load()
    const onUpdate = () => void load()
    globalEventEmitter.onTransactionsUpdated(onUpdate)
    return () => globalEventEmitter.offTransactionsUpdated(onUpdate)
  }, [])

  useEffect(() => {
    const store = RequestStorage.get()
    const load = () =>
      store
        .list()
        .then(setRequests)
        .catch(() => setRequests([]))
        .finally(() => setRequestsHydrated(true))
    void load()
    return store.subscribe(() => void load())
  }, [])

  const onDecline = useCallback((id: string) => void declineRequestById(id).catch(console.warn), [])
  // Every cancel goes through the shared confirm sheet (RequestDetailModal at its confirm step).
  const onCancel = useCallback((id: string) => setCancelRequestId(id), [])
  const requestsById = useMemo(
    () => new Map(requests.map((request) => [request.id, request])),
    [requests],
  )
  const guard = useActionGuard()
  const onSend = useCallback(
    (row: RequestRowView) =>
      // Request context rides router state: ContactPayScreen prefills the amount, works for an
      // unsaved requester tag, and fulfills the request after the send lands.
      guard("send", () =>
        navigate(`/contacts/${encodeURIComponent(row.contactTag ?? "")}/send`, {
          state: {
            request: {
              id: row.id,
              tag: row.contactTag,
              amount: row.amountValue,
              note: requestsById.get(row.id)?.note,
            },
          },
        }),
      ),
    [navigate, requestsById, guard],
  )
  const { remind: onRemind, stateOf: remindStateOf } = useRemind(
    tokenService?.tokenAddress?.toString(),
  )

  const refunds = useSyncExternalStore(onRefundInFlightChanged, refundInFlightVersion)
  const rows = useMemo(() => {
    const visible = withoutPaidLinkReceives(transactions, requests)
    return buildActivityRows(visible, directory, chainNow)
    // directory is a fresh object each render; contacts is the state that actually feeds the rows.
  }, [transactions, requests, directory.contacts, chainNow, refunds])
  useEffect(() => {
    if (!openTxHash && !openPaylink) return
    const row = rows.find((r) =>
      openTxHash ? r.txHash === openTxHash : !!r.paylink && r.paylink === openPaylink,
    )
    if (!row) return
    setDetail(row)
    setNotice(routerNotice ? { text: routerNotice, staleOn: routerNoticeStaleOn } : undefined)
    navigate(".", { replace: true, state: null })
  }, [openTxHash, openPaylink, routerNotice, routerNoticeStaleOn, rows, navigate])
  // The open sheet follows its row, so a pending create settles or fails under it. A row's id
  // moves from queue id to tx hash when it lands, and a creator paylink row's URL gains the tx;
  // the link's secret is what stays put.
  const secretOf = (r: ActivityRowView) => r.paylinkRow?.payToEmailSecret
  const liveDetail =
    detail &&
    (rows.find(
      (r) => r.id === detail.id || (!!secretOf(detail) && secretOf(r) === secretOf(detail)),
    ) ??
      detail)
  useEffect(() => {
    const hit = findBridgeItem(items, { openWithdrawalId, openDepositAddress, openTxHash })
    if (!hit) return
    const target = bridgeDetailTarget(hit)
    if ("savings" in target) setSavingsDetailId(target.savings)
    else if ("withdrawal" in target) setWithdrawalDetailId(target.withdrawal)
    else setDepositDetailId(target.deposit)
    setNotice(routerNotice ? { text: routerNotice, staleOn: routerNoticeStaleOn } : undefined)
    navigate(".", { replace: true, state: null })
  }, [
    openWithdrawalId,
    openDepositAddress,
    openTxHash,
    routerNotice,
    routerNoticeStaleOn,
    items,
    navigate,
  ])
  const sipaRecords = useMemo(
    () =>
      items.flatMap((item) =>
        item.kind === "bridge.sipaDeposit" && !item.credit ? [item.record] : [],
      ),
    [items],
  )
  // Requests from non-contacts are listed on their own page (NonContactRequestsScreen). Without a
  // current read of the contacts, no incoming request can be shown as from a contact.
  const contactsCurrent = directory.hydrated && !directory.failed
  const requestRows = useMemo(() => {
    const contactTags = approvedContactTags(directory.contacts)
    const unlisted = unlistedCodeRequestIds()
    return buildRequestRows(
      withoutAnsweredRequests(requests, transactions).filter(
        (r) =>
          !unlisted.has(r.id.toLowerCase()) &&
          (contactsCurrent ? !isFromNonContact(r, contactTags) : r.direction !== "incoming"),
      ),
      Date.now(),
      sipaRecords,
    ).map((row) => {
      const contact = row.contactTag ? directory.lookup(row.contactTag) : undefined
      return contact ? { ...row, counterparty: contactDisplayName(contact) } : row
    })
    // directory is a fresh object each render; contacts is the state that actually feeds lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, transactions, sipaRecords, directory.contacts, contactsCurrent])
  // The sheet closes when its row is hidden, so it offers no Send, and stays closed if the row returns.
  const incomingDetailRow = incomingDetailId
    ? requestRows.find((r) => r.kind === "incoming" && r.id === incomingDetailId)
    : undefined
  const incomingDetail = incomingDetailRow && requestsById.get(incomingDetailRow.id)
  useEffect(() => {
    if (incomingDetailId && !incomingDetailRow) setIncomingDetailId(null)
  }, [incomingDetailId, incomingDetailRow])
  const paidLinkRows = useMemo(
    () => buildPaidLinkRows(requests, sipaRecords, transactions),
    [requests, sipaRecords, transactions],
  )

  const payerForRequest = useCallback(
    (request: PaymentRequest) => payerForPaidLink(request, transactions, directory),
    // directory is a fresh object each render; contacts is the state that actually feeds resolution.
    [transactions, directory.contacts],
  )

  const openLinkDetail = (id: string) => {
    const request = requestsById.get(id)
    if (request) setRequestLinkDetail(request)
  }

  const openRequestId = routerState?.openRequestId
  useEffect(() => {
    const request = openRequestId ? requestsById.get(openRequestId) : undefined
    if (!request) return
    setRequestLinkDetail(request)
    navigate(".", { replace: true, state: null })
  }, [openRequestId, requestsById, navigate])

  const openDepositExit = (record: SIPADepositRecord, processing?: SipaProcessingState) => {
    const offer = depositDetailOffer(record, processing)
    if (!offer) return
    setDepositDetailId(null)
    setUpgradeBackRun(null)
    setExit({
      kind: "deposit",
      record,
      reason: offer.reason,
      canSweep: offer.canSweep,
      sweepable: offer.sweepable,
    })
  }

  // Straight from the row to the confirm sheet, like the bridge exits: the row's own status is what
  // put the button there. A claim that beat it spends the same nullifier, and that revert has its own
  // copy — the detail sheet is where a live status check happens first.
  const openLinkRecovery = (row: ActivityRowView) => {
    const fragment = row.paylink ? linkFragmentOf(row.paylink) : null
    if (!row.creatorAction || !fragment || !row.paylinkRow) return
    setDetail(null)
    const token = row.paylinkRow.token
    setLinkRecovery({
      action: row.creatorAction,
      fragment,
      amount: token ? usdFigure(String(token.amount)) : row.amount.replace(/^[+-]/, ""),
      createdMs: row.timestampMs,
      untilClaimableSec: row.paylinkRow.untilClaimable,
      refundableUntilSec: row.paylinkRow.refundableUntil,
    })
  }

  const openWithdrawalExit = (record: WithdrawalRecord) => {
    setWithdrawalDetailId(null)
    setExit({ kind: "withdrawal", record })
  }

  const openSwapExit = (record: WithdrawalRecord) => {
    const offer = withdrawalExitOffer(record)
    if (!offer) return
    setWithdrawalDetailId(null)
    setExit({ kind: "swap", record, reason: offer.reason })
  }

  const savingsMoveExit = (move: SavingsMoveRecord, burn: WithdrawalRecord | undefined) => {
    const offer = burn && savingsMoveExitOffer(move, burn)
    if (!burn || !offer) return undefined
    const next: BridgeExit =
      offer === "finalize"
        ? { kind: "withdrawal", record: burn, savings: move.direction === "out" }
        : { kind: "skyEscrow", move, burn }
    return {
      title: offer === "finalize" ? "Finalize manually" : "Run move manually",
      onStart: () => {
        setSavingsDetailId(null)
        setExit(next)
      },
    }
  }

  const withdrawalExit = (record: WithdrawalRecord) => {
    if (canSelfFinalizeWithdrawal(record)) {
      return { title: "Finalize manually", onStart: () => openWithdrawalExit(record) }
    }
    const offer = withdrawalExitOffer(record)
    return offer ? { title: offer.title, onStart: () => openSwapExit(record) } : undefined
  }

  // Records with a groupId show as their group, never as plain withdrawal rows.
  const withdrawalGroups = useMemo(() => withdrawalGroupsOf(withdrawalRecords), [withdrawalRecords])
  const groupDetail = withdrawalGroups.find((g) => g.groupId === withdrawalDetailId) ?? null
  const upgradeDetail =
    items.flatMap((item) =>
      item.kind === "upgrade.batch" && `${item.batch.run}/${item.batch.id}` === upgradeDetailId
        ? [item.batch]
        : [],
    )[0] ?? null

  // Request-link SIPAs render as the request row, not a generic deposit.
  const linkedSipas = requestLinkedSipaAddresses(requests)
  // A migration's arrival address, keyed to the burn that funds it: one whose burn failed never
  // receives anything.
  const migrationBurns = new Map(
    withdrawalRecords
      .filter((r) => r.intent === "migration")
      .map((r) => [r.recipient.toLowerCase(), r] as const),
  )
  // An upgrade is one row over its batches; their deposits are its legs, not rows of their own.
  const upgradeRuns = upgradeRunsOf(items)
  const upgradeArrivals = upgradeRecipients(items)
  const upgradeRunDetail = upgradeRuns.find((run) => run.run === upgradeRunId) ?? null
  const upgradeBack = (close: () => void) =>
    upgradeBackRun
      ? () => {
          close()
          setUpgradeBackRun(null)
          setUpgradeRunId(upgradeBackRun)
        }
      : undefined
  const openUpgradeRun = routerState?.openUpgradeRun
  useEffect(() => {
    if (!openUpgradeRun || !upgradeRuns.some((run) => run.run === openUpgradeRun)) return
    setUpgradeRunId(openUpgradeRun)
    setNotice(routerNotice ? { text: routerNotice } : undefined)
    navigate(".", { replace: true, state: null })
  }, [openUpgradeRun, upgradeRuns, routerNotice, navigate])
  // Registration addresses a burn from this wallet paid (a payment link's signup): the burn row is
  // the registration's, what left the balance; the feed keeps the deposit leg behind it.
  const burnFundedRegistrations = new Set(
    withdrawalRecords
      .filter((r) => r.intent === "registration")
      .map((r) => r.recipient.toLowerCase()),
  )

  const depositDetailItem = depositDetailRow(items, depositDetailId)
  const depositDetail = depositDetailItem?.record ?? null
  const tagDetail = items.find(
    (item): item is Extract<ActivityItem, { kind: "bridge.sipaDeposit" }> =>
      item.kind === "bridge.sipaDeposit" &&
      !item.credit &&
      item.record.sipaAddress.toLowerCase() === tagDetailId?.toLowerCase(),
  )?.record
  const tagDetailTag = tagDetail && registrationTagForDeposit(tagDetail.sipaAddress)
  const depositDetailProcessing = depositDetailItem?.processing
  const depositDetailExit = depositDetail
    ? depositDetailOffer(depositDetail, depositDetailProcessing)
    : null

  const withdrawalDetail =
    items.find(
      (item): item is Extract<ActivityItem, { kind: "bridge.withdrawal" }> =>
        item.kind === "bridge.withdrawal" && item.record.localId === withdrawalDetailId,
    )?.record ?? null

  const requestRowNode = (row: RequestRowView, compact: boolean) => (
    <RequestRow
      key={row.id}
      row={row}
      compact={compact}
      remind={remindStateOf(row.id, row.remindedAt)}
      onDecline={onDecline}
      onSend={onSend}
      onCancel={row.kind === "outgoingLink" ? setCancelLinkId : onCancel}
      onRemind={onRemind}
      onOpen={
        row.kind === "outgoingLink"
          ? () => openLinkDetail(row.id)
          : row.kind === "incoming"
          ? () => setIncomingDetailId(row.id)
          : () => setSentDetailId(row.id)
      }
    />
  )

  const entries: ActivityEntry[] = [
    ...requestRows.map((row) => ({
      id: row.id,
      ts: row.timestampMs,
      direction: row.direction,
      pending: true,
      unpaidRequest: true,
      incomingRequest: row.kind === "incoming",
      node: requestRowNode(row, false),
      compactNode: requestRowNode(row, true),
    })),
    ...paidLinkRows.map((row) => ({
      id: row.id,
      ts: row.timestampMs,
      direction: "in" as const,
      pending: false,
      node: (
        <ActivityListRow
          key={row.id}
          counterparty="Requested via paylink"
          timestamp={rowTimestamp(row.timestampMs)}
          amount={row.amount}
          statusLabel="Paid"
          avatarIcon="link"
          onClick={() => openLinkDetail(row.id)}
          ariaLabel="Open request link details"
        />
      ),
    })),
    ...rows.map((row) => ({
      id: row.id,
      ts: row.timestampMs,
      direction: (row.amount.trim().startsWith("+") ? "in" : "out") as "in" | "out",
      pending: isPendingActivityRow(row),
      node: (
        <ActivityListRow
          key={row.id}
          counterparty={row.counterparty}
          timestamp={row.timestamp}
          amount={row.amount}
          statusLabel={row.statusLabel}
          avatarIcon={row.avatarIcon}
          avatar={
            row.contact ? (
              <GradientInitialAvatar
                name={row.contact.name}
                colors={avatarColors(row.contact.id)}
                size={44}
              />
            ) : undefined
          }
          onClick={() => {
            setNotice(undefined)
            setDetail(row)
          }}
          ariaLabel="Open transaction details"
          actions={[
            ...(row.creatorAction
              ? [
                  {
                    title: LINK_RECOVERY_TITLE[row.creatorAction],
                    onClick: () => openLinkRecovery(row),
                  },
                ]
              : []),
            ...(row.paylink && row.canShare
              ? [
                  phone
                    ? {
                        title: "Share",
                        actionStyle: "gradient" as const,
                        onClick: () =>
                          shareLink(
                            paylinkRowShareUrl(row.paylink!),
                            `I sent you ${row.amount.replace(/^[+-]/, "")} on zk.money`,
                          ),
                      }
                    : {
                        title: copiedLinkId === row.id ? "Copied!" : "Copy link",
                        actionStyle: "gradient" as const,
                        onClick: () => void copyLink(row.id, paylinkRowShareUrl(row.paylink!)),
                      },
                ]
              : []),
          ]}
        />
      ),
    })),
    ...upgradeRuns.map(
      (run): ActivityEntry => ({
        id: `upgrade-run:${run.run}`,
        ts: run.time,
        direction: "in",
        pending: !run.settled,
        node: (
          <UpgradeRunRow
            key={run.run}
            run={run}
            pricing={upgradePricing}
            onOpen={() => {
              setNotice(undefined)
              setUpgradeRunId(run.run)
            }}
          />
        ),
      }),
    ),
    ...oldVersionWithdrawals.map((record): ActivityEntry => {
      const url = record.refunds.at(-1)?.l1TxHash && l1TxUrl(record.refunds.at(-1)!.l1TxHash!)
      const stuck = oldVersionRefundOffer(record)
      return {
        id: `old-version-withdrawal:${record.id}`,
        ts: record.startTime,
        direction: "out",
        pending: record.phase === "sending",
        node: (
          <ActivityListRow
            key={record.id}
            counterparty={shortL1Addr(record.to)}
            counterpartyBadge="Old version"
            timestamp={stuck ? STUCK_SUBLINE : rowTimestamp(record.startTime)}
            amount={`-${usdFigure(formatUnits(withdrawalSent(record), DEFAULT_DECIMALS))}`}
            statusLabel={record.phase === "done" ? undefined : "Releasing"}
            avatarIcon="arrow.up.right"
            onClick={() => url && window.open(url, "_blank", "noopener")}
            ariaLabel="Open the withdrawal on Ethereum"
            actions={
              stuck
                ? [
                    {
                      title: "Process manually",
                      actionStyle: "gradient" as const,
                      onClick: () => setExit({ kind: "oldVersion", record, refund: stuck }),
                    },
                  ]
                : []
            }
          />
        ),
      }
    }),
    // One row for the two burns of a legacy fresh-address withdrawal: worst leg's status, total burned.
    ...withdrawalGroups.map((group): ActivityEntry => {
      const head = group.legs.gas ?? group.records[0]
      const named = [group.legs.gas, group.legs.funds].flatMap((r) => r ?? [])
      const legs = named.length ? named : group.records
      const delayed = legs.find(
        (r) => isWithdrawalDelayed(r) || withdrawalExitOffer(r)?.reason === "stuck",
      )
      const offers = legs.flatMap((r) => withdrawalExit(r) ?? []).slice(0, 1)
      return {
        id: group.groupId,
        ts: withdrawalGroupTime(group),
        direction: "out",
        pending: !isWithdrawalGroupTerminal(group),
        node: (
          <ActivityListRow
            key={group.groupId}
            counterparty={head.recipientAlias ?? shortL1Addr(head.recipient)}
            counterpartyBadge="Fresh address"
            timestamp={delayed ? STUCK_SUBLINE : rowTimestamp(withdrawalGroupTime(group))}
            amount={`-${usdFigure(withdrawalGroupAmount(group))}`}
            statusLabel={
              isFundsLegUnsent(group)
                ? WITHDRAWAL_FUNDS_UNSENT
                : WITHDRAWAL_PHASE_LABEL[worstWithdrawalPhase(group)]
            }
            avatarIcon="wallet"
            onClick={() => {
              setNotice(undefined)
              setWithdrawalDetailId(group.groupId)
            }}
            ariaLabel="Open withdrawal details"
            actions={[
              ...(delayed?.l2TxHash
                ? [{ title: "Check again", onClick: () => void checkAgain(delayed.l2TxHash!) }]
                : []),
              ...offers.map(({ title, onStart }) => ({
                title,
                actionStyle: "gradient" as const,
                onClick: onStart,
              })),
            ]}
          />
        ),
      }
    }),
    ...items.flatMap((item): ActivityEntry[] => {
      if (item.kind === "bridge.withdrawal") {
        if (item.record.groupId) return []
        // A Savings move's burn: one row for the move, as Main sees it.
        if (item.record.skyMove) {
          const move: SavingsMoveRecord = savingsMoves.find(
            (candidate) => candidate.withdrawalLocalId === item.record.localId,
          ) ?? { ...savingsMoveOfWithdrawal(item.record)!, startTime: item.record.startTime }
          return [
            {
              id: item.record.localId,
              ts: bridgeItemTime(item),
              direction: move.direction === "in" ? "out" : "in",
              pending: !isSavingsMoveSettled(move, item.record),
              node: (
                <SavingsMoveRow
                  key={item.record.localId}
                  move={move}
                  burn={item.record}
                  perspective="main"
                  sharePrice={savingsSharePrice}
                  eta={savingsEtaFor(move, item.record)}
                  onOpen={() => {
                    setNotice(undefined)
                    setSavingsDetailId(item.record.localId)
                  }}
                />
              ),
            },
          ]
        }
        return [
          {
            id: item.record.localId,
            ts: bridgeItemTime(item),
            direction: "out",
            pending: !WITHDRAWAL_TERMINAL_PHASES.has(item.record.phase),
            node: (
              <WithdrawalRow
                key={item.record.localId}
                record={item.record}
                onCheckAgain={(hash) => void checkAgain(hash)}
                onOpen={() => {
                  setNotice(undefined)
                  setWithdrawalDetailId(item.record.localId)
                }}
                exit={withdrawalExit(item.record)}
              />
            ),
          },
        ]
      }
      if (item.kind === "bridge.sipaDeposit") {
        if (upgradeArrivals.has(item.record.sipaAddress.toLowerCase())) return []
        const burn = migrationBurns.get(item.record.sipaAddress.toLowerCase())
        const exitTime = burn ? burn.endTime ?? burn.startTime : undefined
        // A migration's arrival shows from its exit on, funded or not; unfunded behind a failed
        // burn, it never receives anything.
        if (
          ((!burn || burn.phase === "failed") && isUnfundedSipaDeposit(item.record)) ||
          linkedSipas.has(item.record.sipaAddress.toLowerCase())
        ) {
          return []
        }
        const pending = !!burn && isUnfundedSipaDeposit(item.record)
        // A migration's arrival sits directly above its exit, pending or funded.
        const ts =
          exitTime !== undefined
            ? Math.max(pending ? 0 : bridgeItemTime(item), exitTime + 1)
            : bridgeItemTime(item)
        const rowId = depositRowId(item)
        const token = depositRowToken(item)
        const openDetail = () => {
          setNotice(undefined)
          setDepositDetailId(
            token ? `${item.record.sipaAddress}:${token}` : item.record.sipaAddress,
          )
        }
        const tag = registrationTagForDeposit(item.record.sipaAddress)
        // The tag's price came out of the deposit before it reached L2; its own row says where it went.
        const tagPrice = tagPriceOf(item.record)
        const tagPurchase =
          tag && tagPrice && item.record.phase === "claimed" && !item.credit
            ? [
                {
                  id: `${item.record.sipaAddress}:tag`,
                  ts: ts - 1,
                  direction: "out" as const,
                  pending: false,
                  node: (
                    <ActivityListRow
                      key={`${item.record.sipaAddress}:tag`}
                      counterparty="Tag purchase"
                      counterpartyBadge={`@${tag}`}
                      timestamp={rowTimestamp(ts)}
                      amount={`-${usdFigure(formatUnits(tagPrice, DEFAULT_DECIMALS))}`}
                      avatarIcon="at"
                      onClick={() => {
                        setNotice(undefined)
                        setTagDetailId(item.record.sipaAddress)
                      }}
                      ariaLabel="Open tag purchase details"
                    />
                  ),
                },
              ]
            : []
        return [
          ...tagPurchase,
          {
            id: rowId,
            ts,
            direction: "in",
            pending: !isSettledSipaPhase(item.record.phase),
            node: (
              <DepositRow
                key={rowId}
                row={sipaDepositIntentRow(item.record, tag, !!burn)}
                processing={item.processing}
                arriving={
                  pending
                    ? { net: burn ? migrationAmounts(burn)?.netDisplay : undefined }
                    : undefined
                }
                time={exitTime !== undefined ? ts : undefined}
                decimals={settlementDecimals(depositTokens, item.record.tokenAddress)}
                onOpen={openDetail}
                onExit={() => openDepositExit(item.record, item.processing)}
              />
            ),
          },
        ]
      }
      return []
    }),
    // The pending registration's own row, unless a burn from this wallet funds it: that burn's
    // row is the registration's until the deposit rail credits the return.
    ...(registrationDeposit &&
    !burnFundedRegistrations.has(registrationDeposit.sipaAddress.toLowerCase())
      ? [
          {
            id: "registration-deposit",
            ts: registrationDeposit.ts,
            direction: "in" as const,
            pending: true,
            node: registrationDeposit.node,
          },
        ]
      : []),
  ].sort((a, b) => b.ts - a.ts)

  const burns = new Map(withdrawalRecords.map((record) => [record.localId, record] as const))
  const ledger = savingsHydrated ? savingsLedger(savingsMoves, burns) : undefined
  // The console says why the figure may be off: shares the records do not cover, moves left out.
  const ledgerKey =
    ledger && savingsPosition
      ? `${ledger.shares}/${savingsPosition.shares}/${ledger.excluded
          .map((e) => e.withdrawalLocalId)
          .join(",")}`
      : undefined
  useEffect(() => {
    if (!ledger || !savingsPosition || !ledgerKey) return
    if (ledger.shares !== savingsPosition.shares || ledger.excluded.length > 0)
      console.info(
        `[savings] earnings: the counted moves add up to ${ledger.shares} shares, ${savingsPosition.shares} held` +
          (ledger.excluded.length
            ? `; left out: ${ledger.excluded
                .map(
                  (e) =>
                    `${e.withdrawalLocalId} (${e.reason}${
                      e.backfilling ? ", awaiting its escrow run's receipt" : ""
                    })`,
                )
                .join(", ")}`
            : ""),
      )
    // Keyed on what the line would say, so it prints once per change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerKey])
  const savingsEntries = savingsMoveEntries(
    savingsMoves,
    burns,
    (localId) => {
      setNotice(undefined)
      setSavingsDetailId(localId)
    },
    savingsSharePrice,
    savingsEtaFor,
  )
  const savingsDetail = savingsDetailId
    ? savingsMoves.find((move) => move.withdrawalLocalId === savingsDetailId) ??
      (() => {
        const record = burns.get(savingsDetailId)
        const move = record && savingsMoveOfWithdrawal(record)
        return move ? { ...move, startTime: record.startTime } : null
      })()
    : null

  return {
    entries,
    savingsEntries,
    savingsHydrated,
    oldVersionLeft: oldVersionLeftovers({
      moves: savingsMoves,
      burns: withdrawalRecords,
      rows,
      sharePrice: savingsSharePrice,
    }),
    savingsLedger: ledger,
    arriving: arrivingFunds({
      // The store, not the feed: the feed hides a deposit behind the burn from this wallet that paid it.
      deposits: depositRecords,
      burns: withdrawalRecords,
      moves: savingsMoves,
      sharePrice: savingsSharePrice,
      transactions,
      // Each figure's own read: a claim stays on its way until the figure shown holds it.
      balanceReadAt: {
        main: activeTokenAddress ? balanceReadAt[activeTokenAddress.toLowerCase()] : undefined,
        savings: savingsPosition?.sharesReadAt,
      },
      upgradeRecipients: upgrades.recipients(),
      oldVersions: { main: oldHoldings.main, savings: oldHoldings.savings },
    }),
    upgradesLoaded: upgradesHydrated,
    hydrated:
      depositsHydrated &&
      upgradesHydrated &&
      withdrawalsHydrated &&
      transactionsHydrated &&
      requestsHydrated &&
      (directory.hydrated || directory.failed) &&
      !catchingUp,
    requestsUnavailable: directory.failed,
    csvSources: walletToken && { walletToken, transactions, items, requests },
    savingsCsvSources: walletToken && { walletToken, moves: savingsMoves, burns },
    detailModals: (
      <>
        {registrationDeposit?.modal}
        {liveDetail && (
          <TxDetailModal
            row={liveDetail}
            note={txNoteFor(liveDetail, requests)}
            notice={detailNoticeFor(notice, liveDetail)}
            onClose={() => setDetail(null)}
          />
        )}
        {withdrawalDetail && (
          <WithdrawalDetailModal
            record={withdrawalDetail}
            amount={withdrawalHeroAmount(withdrawalDetail)}
            notice={detailNoticeFor(notice, withdrawalDetail)}
            onClose={() => setWithdrawalDetailId(null)}
            onCheckAgain={
              isWithdrawalDelayed(withdrawalDetail) && withdrawalDetail.l2TxHash
                ? () => {
                    setWithdrawalDetailId(null)
                    void checkAgain(withdrawalDetail.l2TxHash!)
                  }
                : undefined
            }
            exit={withdrawalExit(withdrawalDetail)}
          />
        )}
        {upgradeDetail && (
          <UpgradeBatchDetailModal
            batch={upgradeDetail}
            onBack={upgradeBack(() => setUpgradeDetailId(null))}
            onClose={() => {
              setUpgradeDetailId(null)
              setUpgradeBackRun(null)
            }}
          />
        )}
        {upgradeRunDetail && (
          <UpgradeRunDetailModal
            run={upgradeRunDetail}
            title={upgradeRunTitle[upgradeRunAccount(upgradeRunDetail.run)]}
            pricing={upgradePricing}
            onViewDeposit={(deposit) => {
              setUpgradeRunId(null)
              setUpgradeBackRun(upgradeRunDetail.run)
              setDepositDetailId(deposit.sipaAddress)
            }}
            onViewBatch={(batch) => {
              setUpgradeRunId(null)
              setUpgradeBackRun(upgradeRunDetail.run)
              setUpgradeDetailId(`${batch.run}/${batch.id}`)
            }}
            onClose={() => setUpgradeRunId(null)}
          />
        )}
        {groupDetail && (
          <FreshWithdrawalDetailModal
            group={groupDetail}
            notice={detailNoticeFor(notice, { phase: worstWithdrawalPhase(groupDetail) })}
            onViewLeg={(record) => {
              setNotice(undefined)
              setWithdrawalDetailId(record.localId)
            }}
            onClose={() => setWithdrawalDetailId(null)}
          />
        )}
        {tagDetail && tagDetailTag && (
          <TagPurchaseModal
            record={tagDetail}
            tag={tagDetailTag}
            price={formatUnits(tagPriceOf(tagDetail), DEFAULT_DECIMALS)}
            onClose={() => setTagDetailId(null)}
          />
        )}
        {depositDetail && (
          <DepositDetailModal
            record={depositDetail}
            registrationTag={registrationTagForDeposit(depositDetail.sipaAddress)}
            exit={
              depositDetailExit
                ? {
                    title: depositDetailExit.title,
                    sweep: depositDetailExit.canSweep,
                    onStart: () => openDepositExit(depositDetail, depositDetailProcessing),
                  }
                : undefined
            }
            notice={notice?.text}
            onBack={upgradeBack(() => setDepositDetailId(null))}
            onClose={() => {
              setDepositDetailId(null)
              setUpgradeBackRun(null)
            }}
          />
        )}
        {exit?.kind === "deposit" && (
          <DepositExitModal
            record={exit.record}
            reason={exit.reason}
            canSweep={exit.canSweep}
            sweepable={exit.sweepable}
            onClose={() => setExit(null)}
          />
        )}
        {linkRecovery && (
          <LinkRecoverModal
            action={linkRecovery.action}
            deps={paylinkDeps}
            fragment={linkRecovery.fragment}
            amount={linkRecovery.amount}
            createdMs={linkRecovery.createdMs}
            untilClaimableSec={linkRecovery.untilClaimableSec}
            refundableUntilSec={linkRecovery.refundableUntilSec}
            onClose={() => setLinkRecovery(null)}
          />
        )}
        {exit?.kind === "withdrawal" && (
          <WithdrawalExitModal
            record={exit.record}
            deployment={
              exit.savings && obsidionWallet
                ? () => savingsFinalizeDeployment(exit.record)
                : undefined
            }
            onClose={() => setExit(null)}
          />
        )}
        {exit?.kind === "oldVersion" && (
          <OldVersionRefundExitModal
            record={exit.record}
            refund={exit.refund}
            onClose={() => setExit(null)}
          />
        )}
        {exit?.kind === "skyEscrow" && (
          <SwapExitModal
            record={withdrawalRecords.find((r) => r.localId === exit.burn.localId) ?? exit.burn}
            move={
              savingsMoves.find((m) => m.withdrawalLocalId === exit.move.withdrawalLocalId) ??
              exit.move
            }
            reason="stuck"
            onClose={() => setExit(null)}
          />
        )}
        {exit?.kind === "swap" && (
          <SwapExitModal
            record={withdrawalRecords.find((r) => r.localId === exit.record.localId) ?? exit.record}
            reason={exit.reason}
            onClose={() => setExit(null)}
          />
        )}
        {incomingDetailRow && incomingDetail && (
          <IncomingRequestDetailModal
            request={incomingDetail}
            onClose={() => setIncomingDetailId(null)}
            onDecline={() => {
              setIncomingDetailId(null)
              onDecline(incomingDetail.id)
            }}
            onSend={() => {
              setIncomingDetailId(null)
              onSend(incomingDetailRow)
            }}
          />
        )}
        {savingsDetail && (
          <SavingsMoveDetailModal
            move={savingsDetail}
            burn={burns.get(savingsDetail.withdrawalLocalId)}
            sharePrice={savingsSharePrice}
            eta={savingsEtaFor(savingsDetail, burns.get(savingsDetail.withdrawalLocalId))}
            onCheckAgain={savingsSource ? settleSavings : undefined}
            exit={savingsMoveExit(savingsDetail, burns.get(savingsDetail.withdrawalLocalId))}
            onWithdraw={() => navigate("/withdraw")}
            onClose={() => setSavingsDetailId(null)}
          />
        )}
        {cancelLinkId && (
          <CancelRequestLinkModal requestId={cancelLinkId} onClose={() => setCancelLinkId(null)} />
        )}
        {requestLinkDetail && (
          <SharePaylinkModal
            request={requestLinkDetail}
            requesterTag={loadWalletIdentity()?.handle ?? ""}
            payer={payerForRequest(requestLinkDetail)}
            onCancel={() => {
              setRequestLinkDetail(null)
              setCancelLinkId(requestLinkDetail.id)
            }}
            onClose={() => setRequestLinkDetail(null)}
          />
        )}
        {sentDetailId && (
          <RequestDetailModal
            requestId={sentDetailId}
            remind={remindStateOf(sentDetailId, requestsById.get(sentDetailId)?.remindedAt)}
            onRemind={() => onRemind(sentDetailId)}
            onClose={() => setSentDetailId(null)}
          />
        )}
        {cancelRequestId && (
          <RequestDetailModal
            requestId={cancelRequestId}
            initialStep="confirm"
            onClose={() => setCancelRequestId(null)}
          />
        )}
      </>
    ),
  }
}
