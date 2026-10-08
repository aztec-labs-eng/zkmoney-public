/**
 * Pure view logic for the activity list: transaction admission, counterparty→contact enrichment
 * (address-first, then bare-tag, then raw — front-core's shared resolver), and fallback labels.
 * Kept UI-free so vitest covers it.
 */
import { PaylinkActionEnum } from "@obsidion/core/constants"
import type { StatusLabel } from "@obsidion/web-ds"
import {
  depositAmounts,
  depositPhaseCopy,
  formatDateLabel,
  formatTimeLabel,
  isNativeEth,
  isZeroAddress,
  normalizeTag,
  PAYLINK_STATUS_LABEL,
  paylinkRowView,
  paylinkStatusFor,
  SIPA_PROCESSING_COPY,
  sipaReasonShown,
  resolveContactByCounterparty,
  resolveContactForTx,
  truncateMiddle,
  validateAddress,
  type ContactRow,
  type FaucetTransaction,
  type PaylinkStatusKind,
  type PaylinkTransaction,
  type PaymentRequest,
  type SIPADepositPhase,
  type SIPADepositRecord,
  type SipaProcessingState,
  type TokenTransaction,
  type Transaction,
  type TransactionStatus,
  type TxContactDirectory,
  DETECTING_AMOUNT,
  isRefundInFlight,
  failureReason,
} from "@obsidion/front-core"
import {
  creatorLinkAction,
  type CreatorLinkAction,
} from "../../features/paylink/creatorLinkActions"
import { tokenAmount, usdFigure } from "../format"
import { contactDisplayName } from "../../features/contacts/contactsView"

export { DETECTING_AMOUNT }

export interface ActivityRowView {
  id: string
  /** Saved-contact name when the counterparty resolves; fallback label otherwise. */
  counterparty: string
  /** Attached when the counterparty resolves — drives the gradient-initial avatar. */
  contact?: ContactRow
  /** The counterparty's @tag when the row knows it, saved or not: its conversation opens by it. */
  counterpartyTag?: string
  /** Chain-link glyph for paylink rows. */
  avatarIcon?: string
  timestamp: string
  /** Epoch ms — sort key for interleaving with the bridge feed. */
  timestampMs: number
  /** Signed fiat, e.g. "+$25.00" / "-$25.00". */
  amount: string
  /**
   * "Pending" / "Failed" / "Not received", or a settled creator paylink row's link status
   * (`paylinkRowView`).
   */
  statusLabel?: StatusLabel
  /**
   * The transaction's own state. Carried so the detail modal can re-derive the badge off a
   * refreshed link status instead of parsing the row's wording.
   */
  status: TransactionStatus
  /** What the detail sheet says about a failed row, in words (`failureReason`); never a raw throw. */
  error?: string
  /** On-chain hash — drives the detail modal's explorer link. Unset for pre-submit synth rows. */
  txHash?: string
  /** Sender-attached memo, when the stored row carries one. */
  note?: string
  /** Stored claim URL — creator paylink rows only; drives the detail modal's share section. */
  paylink?: string
  /** Row-derived claim-lifecycle state for creator paylink rows (the status pill). */
  paylinkStatus?: PaylinkStatusKind
  /** The refund that returned this link's escrow, on a refunded creator row. */
  refundTxHash?: string
  /** The state of the refund behind `refundTxHash`, as its own stored row has it. */
  refundStatus?: TransactionStatus
  /** The creator's link can still be handed out: Share / Copy. */
  canShare?: boolean
  /**
   * The recovery this creator paylink row offers, off its own stored flags and the clock — the row
   * reads no chain. Present means the escrow is the user's to take back, and the row carries the
   * button for it; the detail sheet re-derives the same verdict against a live status.
   */
  creatorAction?: CreatorLinkAction
  /**
   * The stored row behind a creator paylink row. The detail modal's reclaim/cancel gate reads
   * fields no view row carries (flavor, claim window, creator, refund material).
   */
  paylinkRow?: PaylinkTransaction
}

/** Reconstruction fragment of a stored claim URL; null when the URL carries none. */
export function linkFragmentOf(paylink: string): string | null {
  const i = paylink.indexOf("#")
  return i >= 0 && i < paylink.length - 1 ? paylink.slice(i + 1) : null
}

/** On-chain funder + funding tx for the deposit detail sheet. Prefers the Transfer sender. */
export function depositAttribution(record: SIPADepositRecord): {
  funder?: string
  fundingTxHash?: string
} {
  return {
    funder: record.fundingFromAddress ?? record.walletAddress,
    fundingTxHash: record.fundingTxHash,
  }
}

/** Source-wallet name and funder address the deposit detail sheet puts over the facts. */
export function depositHeadline(record: SIPADepositRecord): { title: string; address?: string } {
  return {
    title: record.walletName?.trim() || "Wallet",
    address: depositAttribution(record).funder,
  }
}

/**
 * Phases whose funds will never reach the L2 balance: no sweep can move a `recoverable` deposit,
 * and a `recovered` one already went back out on L1. Their net is not a figure anyone is owed.
 */
export function neverCreditsL2(phase: SIPADepositPhase): boolean {
  return phase === "recoverable" || phase === "recovered"
}

/**
 * A deposit's gross: ETH sent by mistake in ETH, the stables in dollars. The detail sheet shows
 * every ETH digit; a row trims them, or a long figure squeezes out the row's label.
 */
export function depositGrossFigure(
  record: SIPADepositRecord,
  precision: "full" | "row" = "full",
): string {
  const { grossDisplay } = depositAmounts(record)
  if (!isNativeEth(record.tokenAddress)) return usdFigure(grossDisplay)
  return `${precision === "row" ? tokenAmount(grossDisplay) : grossDisplay} ETH`
}

/**
 * The figure a deposit shows in the feed. The leading "+" is what renders an amount as a credit, so
 * only a deposit whose net is on its way into the L2 balance carries one — the rest show the whole
 * sum that sits at (or left) the deposit address, unsigned. `exitable` records show that gross for
 * want of a net.
 */
export function depositRowAmount(record: SIPADepositRecord, exitable: boolean): string {
  const amounts = depositAmounts(record)
  const gross = depositGrossFigure(record, "row")
  if (neverCreditsL2(record.phase)) return gross
  // An exact net needs a stored fee or a stored net; crediting a record with neither hands the user the fee.
  if ((amounts.feeKnown || record.netAmount != null) && amounts.netAtomic > 0n)
    return `+${usdFigure(amounts.netDisplay)}`
  // A gross of zero on a phase still headed for L2 means the L1 amount is not read yet, never a real zero.
  return exitable || amounts.grossAtomic > 0n ? gross : DETECTING_AMOUNT
}

/**
 * The badge under a deposit row's amount, from front-core's `DEPOSIT_PHASE_COPY` so the row, the
 * detail sheet and the bell read the same word. A claimed deposit carries no badge.
 */
export function depositRowStatusLabel(record: SIPADepositRecord): StatusLabel | undefined {
  return depositPhaseCopy(record).pill as StatusLabel | undefined
}

/**
 * A discovered SIPA deposit projected onto its intent — the display shadow of the SIPA's on-chain
 * implementation (DepositSIPA vs RegistrationSIPA). A note-discovered deposit is a plain
 * DepositIntent; one that registered a name is a RegistrationIntent that keeps the `@name` identity.
 * The feed renders both from the same deposit record, so the intent only sets the row's identity and
 * badge. The name is injected (the registering wallet tracks it locally, off-note) via
 * `registrationTagForSipa`.
 */
export type SipaDepositIntentRow =
  | { intent: "deposit"; record: SIPADepositRecord }
  | { intent: "registration"; name: string; record: SIPADepositRecord }
  | { intent: "migration"; record: SIPADepositRecord }

/** `migration`: a migration's burn funds this SIPA, so the row is that migration's arrival. */
export function sipaDepositIntentRow(
  record: SIPADepositRecord,
  registrationName: string | undefined,
  migration = false,
): SipaDepositIntentRow {
  if (registrationName) return { intent: "registration", name: registrationName, record }
  return migration ? { intent: "migration", record } : { intent: "deposit", record }
}

/**
 * The badge under a row's amount: "Pending" / "Failed" ("Not received" for a receive) while the
 * transaction is unsettled, else the given link status's label. The feed's paylink rows read theirs
 * from `paylinkRowView`.
 */
export function activityStatusLabel(
  status: TransactionStatus,
  paylinkStatus: PaylinkStatusKind | undefined,
  incoming = false,
): StatusLabel | undefined {
  if (status === "pending") return "Pending"
  if (status === "failed") return incoming ? "Not received" : "Failed"
  return paylinkStatus && PAYLINK_STATUS_LABEL[paylinkStatus]
}

/**
 * Whether a transaction row files under Pending on Home and Activity: a tx still waiting for the
 * network, or a settled link nobody has claimed — money that left and has not arrived, like an
 * unpaid request. `paylinkStatusFor` reads lifecycle flags alone, so a failed create also reads
 * `awaitingClaim`; only a successful create's link status counts.
 */
export function isPendingActivityRow(row: ActivityRowView): boolean {
  return (
    row.statusLabel === "Pending" ||
    (row.status === "success" && row.paylinkStatus === "awaitingClaim")
  )
}

// A refund is not a movement of its own: the escrow left and came back, so the creator's PAY row —
// reading Cancelled or Reclaimed, carrying both hashes — is the whole round trip in one row.
const VISIBLE_ACTIONS = new Set<string>([
  "send",
  "receive",
  "faucet",
  PaylinkActionEnum.PAY,
  PaylinkActionEnum.CLAIM,
])

function isVisibleActivityRow(
  tx: Transaction,
): tx is TokenTransaction | FaucetTransaction | PaylinkTransaction {
  if (!("token" in tx) || tx.token == null) return false
  return VISIBLE_ACTIONS.has(tx.action)
}

function formatFiat(amount: number, price: number, sign: "+" | "-"): string {
  return `${sign}$${Math.abs(amount * price).toFixed(2)}`
}

function sendLabel(to: string | undefined, contact: ContactRow | undefined, toTag?: string): string {
  if (contact) return contactDisplayName(contact)
  if (toTag) return `@${toTag}`
  if (!to) return "Unknown"
  return validateAddress(to) ? truncateMiddle(to, 15) : to
}

function receiveLabel(from: string | undefined, contact: ContactRow | undefined): string {
  if (contact) return contactDisplayName(contact)
  if (isZeroAddress(from)) return "Faucet"
  if (!from || validateAddress(from)) return "Unknown sender"
  return from
}

/** The note a transaction's detail shows: the transfer's own memo, else the note of the request it paid. */
export function txNoteFor(row: ActivityRowView, requests: PaymentRequest[]): string | undefined {
  if (row.note) return row.note
  const hash = row.txHash?.toLowerCase()
  if (!hash) return undefined
  return requests.find((r) => r.fulfillmentTxHash?.toLowerCase() === hash)?.note || undefined
}

/**
 * Projects TransactionStorage rows to enriched activity rows, newest first. `nowSec` is chain
 * time; while it is unknown no creator recovery is offered (the contract gates on block time, not
 * the wall clock). Reads this page's running refunds, so callers re-run it on
 * `onRefundInFlightChanged`.
 */
export function buildActivityRows(
  transactions: Transaction[],
  directory: TxContactDirectory,
  nowSec?: number,
): ActivityRowView[] {
  // A refund files no activity row of its own, but its stored row settles like any other.
  const statusByHash = new Map(
    transactions.flatMap((tx) => (tx.txHash ? [[tx.txHash, tx.status] as const] : [])),
  )
  return transactions
    .filter(isVisibleActivityRow)
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((tx) => {
      const isSend = tx.action === "send"
      const isFaucet = tx.action === "faucet"
      const isPaylink = tx.action === PaylinkActionEnum.PAY || tx.action === PaylinkActionEnum.CLAIM
      const isPaylinkCreate = tx.action === PaylinkActionEnum.PAY
      const paylink =
        isPaylinkCreate && "paylink" in tx && typeof tx.paylink === "string"
          ? tx.paylink
          : undefined
      const to = "to" in tx && typeof tx.to === "string" ? tx.to : undefined
      const from = "from" in tx && typeof tx.from === "string" ? tx.from : undefined
      const senderL2 =
        "senderL2Address" in tx && typeof tx.senderL2Address === "string"
          ? tx.senderL2Address
          : undefined

      const clockSec = nowSec ?? Math.floor(Date.now() / 1000)
      const paylinkStatus = isPaylinkCreate
        ? paylinkStatusFor(tx as PaylinkTransaction, clockSec)
        : undefined
      const refundTxHash =
        isPaylinkCreate && "refundTxHash" in tx && typeof tx.refundTxHash === "string"
          ? tx.refundTxHash
          : undefined
      const refundStatus = refundTxHash ? statusByHash.get(refundTxHash) : undefined
      const linkView = isPaylink
        ? paylinkRowView(tx as PaylinkTransaction, {
            linkStatus: paylinkStatus,
            offer:
              paylinkStatus && nowSec != null
                ? creatorLinkAction(tx as PaylinkTransaction, { nowSec, liveStatus: paylinkStatus })
                : null,
            refundStatus,
            refundStarting: isRefundInFlight((tx as PaylinkTransaction).payToEmailSecret ?? ""),
            nowSec: clockSec,
          })
        : undefined

      let contact: ContactRow | undefined
      let counterparty: string
      let counterpartyTag: string | undefined
      if (linkView) {
        counterparty = linkView.title
      } else if (isFaucet) {
        counterparty = "Faucet drip"
      } else if (isSend) {
        contact = to ? resolveContactByCounterparty(to, directory) : undefined
        const toTag = "toTag" in tx ? tx.toTag : undefined
        counterparty = sendLabel(to, contact, toTag)
        counterpartyTag = toTag
      } else {
        contact =
          from || senderL2 ? resolveContactForTx(from ?? "", senderL2, directory) : undefined
        counterparty = receiveLabel(from, contact)
        counterpartyTag = from && !validateAddress(from) ? (normalizeTag(from) ?? undefined) : undefined
      }

      const outgoing = isSend || tx.action === PaylinkActionEnum.PAY
      return {
        id: tx.txHash || tx.queueId || String(tx.timestamp),
        counterparty,
        contact,
        counterpartyTag: contact?.addressKind === "aztec-l2" ? contact.tag : counterpartyTag,
        avatarIcon: isPaylink ? "link" : tx.status === "pending" ? "clock-outline" : undefined,
        timestamp: `${formatDateLabel(tx.timestamp)}, ${formatTimeLabel(tx.timestamp)}`,
        timestampMs: tx.timestamp,
        // Scanned rows carry no price; the wallet's assets are USD-pegged, so 1:1.
        amount: formatFiat(tx.token?.amount ?? 0, tx.token?.price || 1, outgoing ? "-" : "+"),
        statusLabel: linkView
          ? linkView.statusLabel
          : activityStatusLabel(tx.status, undefined, tx.action === "receive"),
        status: tx.status,
        error: failureReason(tx),
        txHash: tx.txHash || undefined,
        note: "memo" in tx && typeof tx.memo === "string" && tx.memo ? tx.memo : undefined,
        paylink,
        // A landed refund reads refunded before the reconciler flags the row; the Pending tab follows it.
        paylinkStatus: linkView?.refunded ? "refunded" : paylinkStatus,
        refundTxHash,
        refundStatus,
        canShare: linkView?.canShare,
        creatorAction: linkView?.recovery ?? undefined,
        paylinkRow: isPaylinkCreate ? (tx as PaylinkTransaction) : undefined,
      }
    })
}

/**
 * What a pending deposit row says in its timestamp slot, or undefined for the time: the processing reason by the
 * shared `sipaReasonShown` rule, in the words its notification uses, else the stuck wording once `stuck`.
 */
export function depositRowSubline(
  processing: SipaProcessingState | undefined,
  record: Pick<SIPADepositRecord, "phase" | "startTime" | "sweepTxHash">,
  stuck: boolean,
): string | undefined {
  if (sipaReasonShown(processing, record)) return SIPA_PROCESSING_COPY[processing.reason.kind].short
  return stuck ? STUCK_SUBLINE : undefined
}

/** What a row still waiting on a relayer or a finalizer says in the timestamp slot. */
export const STUCK_SUBLINE = "Taking longer than usual"
