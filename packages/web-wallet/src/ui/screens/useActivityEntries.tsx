import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import {
  ActivityListRow,
  GradientInitialAvatar,
  avatarColors,
  type StatusLabel,
} from "@obsidion/web-ds"
import {
  ActivityFeed,
  SIPADepositStore,
  TransactionStorage,
  RequestStorage,
  buildPaidLinkRows,
  buildRequestRows,
  canSelfFinalizeWithdrawal,
  globalEventEmitter,
  isSettledSipaPhase,
  isUnfundedSipaDeposit,
  isWithdrawalDelayed,
  payerForPaidLink,
  requestLinkedSipaAddresses,
  useAssetContext,
  useCachedRecords,
  useContactsDirectory,
  withoutPaidLinkReceives,
  withoutAnsweredRequests,
  WITHDRAWAL_TERMINAL_PHASES,
  type ActivityItem,
  type BridgeActivityItem,
  type PaymentRequest,
  type RequestRowView,
  type SIPADepositRecord,
  type Transaction,
  type WithdrawalRecord,
  useSyncCatchingUp,
  WITHDRAWAL_PHASE_COPY,
} from "@obsidion/front-core"
import { declineRequestById, remindRequestById } from "../../features/contacts/requestActions"
import { RequestDetailModal } from "../../features/contacts/RequestDetailModal"
import { DepositExitModal } from "../../features/deposit/DepositExitModal"
import {
  isStuckSweep,
  recoveryReasonFor,
  type RecoveryReason,
} from "../../features/deposit/sipaRecovery"
import { canSelfSweep } from "../../features/deposit/sipaSweep"
import { loadWalletIdentity } from "../../features/identity/walletIdentity"
import { usePolledChainSeconds } from "../../features/paylink/chainTime"
import {
  canManualRegistrationSweep,
  registrationRecordForSipa,
} from "../../features/onboarding/registrationSweep"
import {
  registrationTagForSipa,
  useRegistrationDepositEntry,
} from "../../features/onboarding/useRegistrationDepositEntry"
import type { CreatorLinkAction } from "../../features/paylink/creatorLinkActions"
import { LinkRecoverModal } from "../../features/paylink/LinkRecoverModal"
import { usePaylinkDeps } from "../../features/paylink/usePaylinkDeps"
import { IncomingRequestDetailModal } from "../../features/requests/IncomingRequestDetailModal"
import { SharePaylinkModal } from "../../features/requests/SharePaylinkModal"
import { RemoveRequestLinkModal } from "../../features/requests/RemoveRequestLinkModal"
import { useWithdrawals } from "../../features/withdraw/useWithdrawals"
import { SwapExitModal } from "../../features/withdraw/SwapExitModal"
import { swapExitReasonFor, type SwapExitReason } from "../../features/withdraw/swapRecovery"
import { WithdrawalExitModal } from "../../features/withdraw/WithdrawalExitModal"
import { getWithdrawalStore } from "../../features/withdraw/withdrawGateway"
import { migrationAmounts } from "../../features/migration/migrationFee"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { rowTimestamp, shortAddr, usdFigure } from "../format"
import { writeClipboard } from "../hooks"
import { usePhoneLayout } from "../usePhoneLayout"
import { contactDisplayName } from "../../features/contacts/contactsView"
import {
  buildActivityRows,
  depositRowAmount,
  depositRowStatusLabel,
  isPendingActivityRow,
  linkFragmentOf,
  sipaDepositIntentRow,
  txNoteFor,
  type ActivityRowView,
  type SipaDepositIntentRow,
} from "./activityView"
import { DepositDetailModal } from "./DepositDetailModal"
import { TxDetailModal } from "./TxDetailModal"
import { WithdrawalDetailModal, withdrawalHeroAmount } from "./WithdrawalDetailModal"

/** Feed-row wording per phase, from the shared copy table; a `done` withdrawal carries no status. */
export const WITHDRAWAL_PHASE_LABEL = Object.fromEntries(
  Object.entries(WITHDRAWAL_PHASE_COPY).map(([phase, copy]) => [phase, copy.pill]),
) as Record<WithdrawalRecord["phase"], StatusLabel | undefined>

/** One feed instance per page load, unioning SIPA deposits + withdrawals. */
function getActivityFeed(): ActivityFeed {
  return ActivityFeed.get(SIPADepositStore.get(webStorage), getWithdrawalStore())
}

/** What a row still waiting on a relayer says in the timestamp slot. */
const STUCK_SUBLINE = "Taking longer than usual"

/**
 * The exit a deposit row offers, or null where it offers none. A sweep may still land on a stuck
 * deposit, so it stays pending and only says so in the subline; one no sweep can move is a state of
 * its own. "Sweep manually" opens the two-exit sheet, "Recover" the recover-only one.
 */
function depositExitOffer(record: SIPADepositRecord): {
  reason: RecoveryReason | null
  canSweep: boolean
  waiting: boolean
  title: string
} | null {
  const reason = recoveryReasonFor(record)
  // A registration-backed deposit follows the registration's own gate on the rail's stuck clock;
  // see registrationRecordForSipa for why the plain sweep can never move one.
  const registration = registrationRecordForSipa(record.sipaAddress)
  const canSweep = registration
    ? isStuckSweep(record) && canManualRegistrationSweep(registration)
    : canSelfSweep(record)
  if (!reason && !canSweep) return null
  const waiting = reason === "stuck" || canSweep
  return { reason, canSweep, waiting, title: waiting ? "Sweep manually" : "Recover" }
}

/**
 * The detail sheet's offer: the row's clocked offer when it exists, else a manual sweep for any
 * still-pending deposit that carries its derived pair — opening the detail IS the "I want to act
 * now" signal, so the sheet never makes the user wait out the row's stuck clock.
 */
function depositDetailOffer(record: SIPADepositRecord): ReturnType<typeof depositExitOffer> {
  const clocked = depositExitOffer(record)
  if (clocked) return clocked
  if (isSettledSipaPhase(record.phase) || record.phase === "recoverable") return null
  if (!record.recipientHash || (!record.recoveryAddress && !record.origin)) return null
  const registration = registrationRecordForSipa(record.sipaAddress)
  if (registration && !canManualRegistrationSweep(registration)) return null
  return { reason: null, canSweep: true, waiting: true, title: "Sweep manually" }
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
  onFinalize,
  onSwapExit,
}: {
  record: WithdrawalRecord
  onCheckAgain: (l2TxHash: string) => void
  onOpen: () => void
  onFinalize: () => void
  onSwapExit: () => void
}) {
  const offer = withdrawalExitOffer(record)
  const delayed = isWithdrawalDelayed(record) || offer?.reason === "stuck"
  const checkAgain = delayed && record.l2TxHash ? () => onCheckAgain(record.l2TxHash!) : undefined
  // A burn to this wallet's registration SIPA paid for its tag, not a withdrawal to a stranger.
  const registrationTag = registrationTagForSipa(record.recipient)
  const migration = record.intent === "migration"
  return (
    <ActivityListRow
      counterparty={
        migration
          ? "Migration"
          : registrationTag
          ? `@${registrationTag}`
          : record.recipientAlias ?? shortAddr(record.recipient)
      }
      counterpartyBadge={
        migration
          ? record.phase === "done"
            ? "Left old network"
            : "Leaving old network"
          : registrationTag
          ? "Registration"
          : record.source === "paylink"
          ? "Paylink → Ethereum"
          : "Withdrawal"
      }
      timestamp={delayed ? STUCK_SUBLINE : rowTimestamp(record.endTime ?? record.startTime)}
      amount={
        migration ? `-${usdFigure(record.amount)}` : `-${record.amount} ${record.tokenSymbol}`
      }
      statusLabel={WITHDRAWAL_PHASE_LABEL[record.phase]}
      avatarIcon="wallet"
      onClick={onOpen}
      ariaLabel="Open withdrawal details"
      actions={[
        ...(checkAgain ? [{ title: "Check again", onClick: checkAgain }] : []),
        ...(canSelfFinalizeWithdrawal(record)
          ? [
              {
                title: "Finalize manually",
                actionStyle: "gradient" as const,
                onClick: onFinalize,
              },
            ]
          : []),
        ...(offer
          ? [{ title: offer.title, actionStyle: "gradient" as const, onClick: onSwapExit }]
          : []),
      ]}
    />
  )
}

function DepositRow({
  row,
  arriving,
  time,
  onOpen,
  onExit,
}: {
  /**
   * A migration's arrival before its funds land. `net` is what the exit brings, display units;
   * unset while a fee is unknown, so the row shows no figure rather than a wrong one.
   */
  arriving?: { net?: string }
  /** When the row is dated; the record's own time where unset. */
  time?: number
  /** The deposit projected onto its intent: a plain DepositIntent, or a RegistrationIntent that
   *  keeps the `@name` identity. */
  row: SipaDepositIntentRow
  onOpen: () => void
  onExit: () => void
}) {
  const { record } = row
  const offer = depositExitOffer(record)
  const registration = row.intent === "registration" ? row : undefined
  const migration = row.intent === "migration"
  return (
    <ActivityListRow
      counterparty={registration ? `@${registration.name}` : migration ? "Migration" : "Deposit"}
      counterpartyBadge={
        registration
          ? "Registration"
          : migration
          ? isSettledSipaPhase(record.phase)
            ? "Arrived"
            : "Arriving on new network"
          : undefined
      }
      timestamp={offer?.waiting ? STUCK_SUBLINE : rowTimestamp(time ?? record.startTime)}
      amount={
        arriving
          ? arriving.net
            ? `+${usdFigure(arriving.net)}`
            : ""
          : depositRowAmount(record, !!offer)
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

/** What each recovery calls itself, in the words the detail sheet's button uses. */
const LINK_RECOVERY_TITLE: Record<CreatorLinkAction, string> = {
  reclaim: "Reclaim",
  cancel: "Cancel",
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
    }
  | { kind: "withdrawal"; record: WithdrawalRecord }
  | { kind: "swap"; record: WithdrawalRecord; reason: SwapExitReason }

/** Actionable pending-request row — Decline/Send incoming, Cancel/Remind to a contact, Remove/Share on
 *  a link. Remove only drops the local row: nothing can revoke a minted link. */
export function RequestRow({
  row,
  reminded,
  onDecline,
  onSend,
  onCancel,
  onRemind,
  onRemove,
  onOpen,
}: {
  row: RequestRowView
  reminded: boolean
  onDecline: (id: string) => void
  onSend: (row: RequestRowView) => void
  onCancel: (id: string) => void
  onRemind: (id: string) => void
  onRemove?: (id: string) => void
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
            title: reminded ? "Reminder sent" : "Remind",
            actionStyle: "gradient" as const,
            onClick: () => !reminded && onRemind(row.id),
          },
        ]
      : [
          ...(onRemove ? [{ title: "Remove", onClick: () => onRemove(row.id) }] : []),
          ...(onOpen ? [{ title: "Share", actionStyle: "gradient" as const, onClick: onOpen }] : []),
        ]
  const content = (
    <ActivityListRow
      counterparty={isLink ? "Requested via paylink" : row.counterparty}
      counterpartyBadge={isLink ? undefined : "Requested"}
      timestamp={rowTimestamp(row.timestampMs)}
      amount={row.amount}
      statusLabel={isLink && row.statusLabel === "Pending" ? "Unpaid" : row.statusLabel}
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
      actions={actions}
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
}

export interface ActivityEntriesState {
  entries: ActivityEntry[]
  /** True once every source has served its last-known state from storage. */
  hydrated: boolean
  detailModals: ReactNode
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
        (item.record.sipaAddress.toLowerCase() === deposit ||
          (!!txHash && item.record.claimTxHash?.toLowerCase() === txHash))),
  )
}

export function useActivityEntries(): ActivityEntriesState {
  const navigate = useNavigate()
  const directory = useContactsDirectory()
  const { tokenService } = useAssetContext()
  const { records: withdrawalRecords, checkAgain, hydrated: withdrawalsHydrated } = useWithdrawals()
  const paylinkDeps = usePaylinkDeps()
  const feed = useMemo(getActivityFeed, [])
  const registrationDeposit = useRegistrationDepositEntry()
  const { hydrated: depositsHydrated } = useCachedRecords(
    useMemo(() => SIPADepositStore.get(webStorage), []),
  )
  const [items, setItems] = useState<ActivityItem[]>(() => feed.list())
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [transactionsHydrated, setTransactionsHydrated] = useState(false)
  const catchingUp = useSyncCatchingUp()
  const [requests, setRequests] = useState<PaymentRequest[]>([])
  const [requestsHydrated, setRequestsHydrated] = useState(false)
  const [remindedIds, setRemindedIds] = useState<ReadonlySet<string>>(new Set())
  const [detail, setDetail] = useState<ActivityRowView | null>(null)
  // Held by id, not by value: the tracker advances the record while the sheet is
  // open and the ladder has to follow it.
  const [withdrawalDetailId, setWithdrawalDetailId] = useState<string | null>(null)
  const [depositDetailId, setDepositDetailId] = useState<string | null>(null)
  const [requestLinkDetail, setRequestLinkDetail] = useState<PaymentRequest | null>(null)
  const [cancelRequestId, setCancelRequestId] = useState<string | null>(null)
  const [removeLinkId, setRemoveLinkId] = useState<string | null>(null)
  const [incomingDetail, setIncomingDetail] = useState<PaymentRequest | null>(null)
  // Held by value, unlike the details above: a submitted exit advances its record straight out of
  // the filtered list, and a sheet mid-submit must not go with it.
  const [exit, setExit] = useState<BridgeExit | null>(null)
  const [linkRecovery, setLinkRecovery] = useState<LinkRecovery | null>(null)
  // Rows offer Cancel during grace and Reclaim after expiry; a mounted list must flip as chain
  // time crosses those boundaries, and offers neither until the tip has been read.
  const chainNow = usePolledChainSeconds(paylinkDeps?.wallet.node)

  useEffect(() => feed.onChanged(setItems), [feed])

  // A just-created paylink or a tapped notification lands here with its row key in router state;
  // open its detail once the row exists, then clear the state so a back/refresh doesn't reopen it.
  const routerState = useLocation().state as {
    openTxHash?: string
    /** A creator paylink row by its claim URL — the key a row has before its tx hash. */
    openPaylink?: string
    openWithdrawalId?: string
    openDepositAddress?: string
    /** Full text of the notification that opened the detail. */
    notice?: string
  } | null
  const routerNotice = routerState?.notice
  // Set only when a notification opens a detail; every row tap clears it.
  const [notice, setNotice] = useState<string>()
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
  const onSend = useCallback(
    (row: RequestRowView) =>
      // Request context rides router state: ContactPayScreen prefills the amount, works for an
      // unsaved requester tag, and fulfills the request after the send lands.
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
    [navigate, requestsById],
  )
  const onRemind = useCallback(
    (id: string) => {
      void remindRequestById(id, tokenService?.tokenAddress?.toString())
        .then((ok) => ok && setRemindedIds((prev) => new Set(prev).add(id)))
        .catch(console.warn)
    },
    [tokenService],
  )

  const rows = useMemo(() => {
    const visible = withoutPaidLinkReceives(transactions, requests)
    return buildActivityRows(visible, directory, chainNow)
    // directory is a fresh object each render; contacts is the state that actually feeds the rows.
  }, [transactions, requests, directory.contacts, chainNow])
  useEffect(() => {
    if (!openTxHash && !openPaylink) return
    const row = rows.find((r) =>
      openTxHash ? r.txHash === openTxHash : !!r.paylink && r.paylink === openPaylink,
    )
    if (!row) return
    setDetail(row)
    setNotice(routerNotice)
    navigate(".", { replace: true, state: null })
  }, [openTxHash, openPaylink, routerNotice, rows, navigate])
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
    if (hit.kind === "bridge.withdrawal") setWithdrawalDetailId(hit.record.localId)
    else if (hit.kind === "bridge.sipaDeposit") setDepositDetailId(hit.record.sipaAddress)
    setNotice(routerNotice)
    navigate(".", { replace: true, state: null })
  }, [openWithdrawalId, openDepositAddress, openTxHash, routerNotice, items, navigate])
  const sipaRecords = useMemo(
    () => items.flatMap((item) => (item.kind === "bridge.sipaDeposit" ? [item.record] : [])),
    [items],
  )
  const requestRows = useMemo(
    () =>
      buildRequestRows(withoutAnsweredRequests(requests, transactions), Date.now(), sipaRecords).map(
        (row) => {
          const contact = row.contactTag ? directory.lookup(row.contactTag) : undefined
          return contact ? { ...row, counterparty: contactDisplayName(contact) } : row
        },
      ),
    // directory is a fresh object each render; contacts is the state that actually feeds lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requests, transactions, sipaRecords, directory.contacts],
  )
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

  const openDepositExit = (record: SIPADepositRecord) => {
    const offer = depositDetailOffer(record)
    if (!offer) return
    setDepositDetailId(null)
    setExit({ kind: "deposit", record, reason: offer.reason, canSweep: offer.canSweep })
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

  // Request-link SIPAs render as the request row, not a generic deposit.
  const linkedSipas = requestLinkedSipaAddresses(requests)
  // A migration's arrival address, keyed to the burn that funds it: one whose burn failed never
  // receives anything.
  const migrationBurns = new Map(
    withdrawalRecords
      .filter((r) => r.intent === "migration")
      .map((r) => [r.recipient.toLowerCase(), r] as const),
  )

  const depositDetail =
    items.find(
      (item): item is Extract<ActivityItem, { kind: "bridge.sipaDeposit" }> =>
        item.kind === "bridge.sipaDeposit" &&
        item.record.sipaAddress.toLowerCase() === depositDetailId?.toLowerCase(),
    )?.record ?? null
  const depositDetailExit = depositDetail ? depositDetailOffer(depositDetail) : null

  const withdrawalDetail =
    items.find(
      (item): item is Extract<ActivityItem, { kind: "bridge.withdrawal" }> =>
        item.kind === "bridge.withdrawal" && item.record.localId === withdrawalDetailId,
    )?.record ?? null

  const entries: ActivityEntry[] = [
    ...requestRows.map((row) => ({
      id: row.id,
      ts: row.timestampMs,
      direction: row.direction,
      pending: true,
      unpaidRequest: true,
      incomingRequest: row.kind === "incoming",
      node: (
        <RequestRow
          key={row.id}
          row={row}
          reminded={remindedIds.has(row.id)}
          onDecline={onDecline}
          onSend={onSend}
          onCancel={onCancel}
          onRemind={onRemind}
          onRemove={row.kind === "outgoingLink" ? setRemoveLinkId : undefined}
          onOpen={
            row.kind === "outgoingLink"
              ? () => openLinkDetail(row.id)
              : row.kind === "incoming"
              ? () => setIncomingDetail(requestsById.get(row.id) ?? null)
              : row.contactTag
              ? () => navigate(`/contacts/${encodeURIComponent(row.contactTag!)}`)
              : undefined
          }
        />
      ),
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
            ...(row.paylink && row.paylinkStatus === "awaitingClaim"
              ? [
                  phone
                    ? {
                        title: "Share",
                        actionStyle: "gradient" as const,
                        onClick: () =>
                          shareLink(row.paylink!, `I sent you ${row.amount.replace(/^[+-]/, "")} on zk.money`),
                      }
                    : {
                        title: copiedLinkId === row.id ? "Copied!" : "Copy link",
                        actionStyle: "gradient" as const,
                        onClick: () => void copyLink(row.id, row.paylink!),
                      },
                ]
              : []),
          ]}
        />
      ),
    })),
    ...items.flatMap((item): ActivityEntry[] => {
      if (item.kind === "bridge.withdrawal") {
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
                onFinalize={() => openWithdrawalExit(item.record)}
                onSwapExit={() => openSwapExit(item.record)}
              />
            ),
          },
        ]
      }
      if (item.kind === "bridge.sipaDeposit") {
        const burn = migrationBurns.get(item.record.sipaAddress.toLowerCase())
        // A migration's arrival shows from the burn on, funded or not; unfunded behind a failed
        // burn, it never receives anything.
        if (
          ((!burn || burn.phase === "failed") && isUnfundedSipaDeposit(item.record)) ||
          linkedSipas.has(item.record.sipaAddress.toLowerCase())
        ) {
          return []
        }
        const pending = !!burn && isUnfundedSipaDeposit(item.record)
        // A migration's arrival sits directly above its exit, pending or funded.
        const ts = burn
          ? Math.max(pending ? 0 : bridgeItemTime(item), (burn.endTime ?? burn.startTime) + 1)
          : bridgeItemTime(item)
        return [
          {
            id: item.record.sipaAddress,
            ts,
            direction: "in",
            pending: !isSettledSipaPhase(item.record.phase),
            node: (
              <DepositRow
                key={item.record.sipaAddress}
                row={sipaDepositIntentRow(
                  item.record,
                  registrationTagForSipa(item.record.sipaAddress),
                  !!burn,
                )}
                arriving={pending ? { net: migrationAmounts(burn)?.netDisplay } : undefined}
                time={burn ? ts : undefined}
                onOpen={() => {
                  setNotice(undefined)
                  setDepositDetailId(item.record.sipaAddress)
                }}
                onExit={() => openDepositExit(item.record)}
              />
            ),
          },
        ]
      }
      return []
    }),
    ...(registrationDeposit
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

  return {
    entries,
    hydrated:
      depositsHydrated &&
      withdrawalsHydrated &&
      transactionsHydrated &&
      requestsHydrated &&
      !catchingUp,
    detailModals: (
      <>
        {registrationDeposit?.modal}
        {liveDetail && (
          <TxDetailModal
            row={liveDetail}
            note={txNoteFor(liveDetail, requests)}
            notice={notice}
            onClose={() => setDetail(null)}
          />
        )}
        {withdrawalDetail && (
          <WithdrawalDetailModal
            record={withdrawalDetail}
            amount={withdrawalHeroAmount(withdrawalDetail)}
            notice={notice}
            onClose={() => setWithdrawalDetailId(null)}
            onCheckAgain={
              isWithdrawalDelayed(withdrawalDetail) && withdrawalDetail.l2TxHash
                ? () => {
                    setWithdrawalDetailId(null)
                    void checkAgain(withdrawalDetail.l2TxHash!)
                  }
                : undefined
            }
            onFinalize={
              canSelfFinalizeWithdrawal(withdrawalDetail)
                ? () => openWithdrawalExit(withdrawalDetail)
                : undefined
            }
            swapExit={
              withdrawalExitOffer(withdrawalDetail)
                ? {
                    title: withdrawalExitOffer(withdrawalDetail)!.title,
                    onStart: () => openSwapExit(withdrawalDetail),
                  }
                : undefined
            }
          />
        )}
        {depositDetail && (
          <DepositDetailModal
            record={depositDetail}
            registrationTag={registrationTagForSipa(depositDetail.sipaAddress)}
            exit={
              depositDetailExit
                ? {
                    title: depositDetailExit.title,
                    onStart: () => openDepositExit(depositDetail),
                  }
                : undefined
            }
            notice={notice}
            onClose={() => setDepositDetailId(null)}
          />
        )}
        {exit?.kind === "deposit" && (
          <DepositExitModal
            record={exit.record}
            reason={exit.reason}
            canSweep={exit.canSweep}
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
          <WithdrawalExitModal record={exit.record} onClose={() => setExit(null)} />
        )}
        {exit?.kind === "swap" && (
          <SwapExitModal record={exit.record} reason={exit.reason} onClose={() => setExit(null)} />
        )}
        {incomingDetail && (
          <IncomingRequestDetailModal
            request={incomingDetail}
            onClose={() => setIncomingDetail(null)}
            onDecline={() => {
              setIncomingDetail(null)
              onDecline(incomingDetail.id)
            }}
            onSend={() => {
              const row = requestRows.find((r) => r.id === incomingDetail.id)
              setIncomingDetail(null)
              if (row) onSend(row)
            }}
          />
        )}
        {removeLinkId && (
          <RemoveRequestLinkModal requestId={removeLinkId} onClose={() => setRemoveLinkId(null)} />
        )}
        {requestLinkDetail && (
          <SharePaylinkModal
            request={requestLinkDetail}
            requesterTag={loadWalletIdentity()?.handle ?? ""}
            payer={payerForRequest(requestLinkDetail)}
            onClose={() => setRequestLinkDetail(null)}
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
