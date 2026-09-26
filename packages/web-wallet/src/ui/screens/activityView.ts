/**
 * Pure view logic for the activity list: transaction admission, counterparty→contact enrichment
 * (address-first, then bare-tag, then raw — front-core's shared resolver), and fallback labels.
 * Kept UI-free so vitest covers it.
 */
import { PaylinkActionEnum } from "@obsidion/core/constants"
import type { StatusLabel } from "@obsidion/web-ds"
import {
  depositAmounts,
  formatDateLabel,
  formatTimeLabel,
  isSettledSipaPhase,
  isZeroAddress,
  normalizeTag,
  PAYLINK_STATUS_LABEL,
  paylinkStatusFor,
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
  type TokenTransaction,
  type Transaction,
  type TransactionStatus,
  type TxContactDirectory,
  DETECTING_AMOUNT,
  INTERRUPTED_SEND_ERROR,
} from "@obsidion/front-core"
import {
  creatorLinkAction,
  type CreatorLinkAction,
} from "../../features/paylink/creatorLinkActions"
import { usdFigure } from "../format"
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
  /** "Pending" / "Failed", or a settled creator paylink row's link status (`activityStatusLabel`). */
  statusLabel?: StatusLabel
  /**
   * The transaction's own state. Carried so the detail modal can re-derive the badge through
   * `activityStatusLabel` off a refreshed link status instead of parsing the row's wording.
   */
  status: TransactionStatus
  /**
   * What the detail sheet says about a failed row. Only the interruption sweep's own message is
   * carried; other stored errors are raw throws and stay off the screen.
   */
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
 * The figure a deposit shows in the feed and in its detail modal. The leading "+" is what renders
 * an amount as a credit, so only a deposit whose net is on its way into the L2 balance carries one —
 * the rest show the whole sum that sits at (or left) the deposit address, unsigned. `exitable`
 * records show that gross for want of a net.
 */
export function depositRowAmount(record: SIPADepositRecord, exitable: boolean): string {
  const amounts = depositAmounts(record)
  const gross = usdFigure(amounts.grossDisplay)
  if (neverCreditsL2(record.phase)) return gross
  // An exact net needs a stored fee or a stored net; crediting a record with neither hands the user the fee.
  if ((amounts.feeKnown || record.netAmount != null) && amounts.netAtomic > 0n)
    return `+${usdFigure(amounts.netDisplay)}`
  // A gross of zero on a phase still headed for L2 means the L1 amount is not read yet, never a real zero.
  return exitable || amounts.grossAtomic > 0n ? gross : DETECTING_AMOUNT
}

/**
 * The badge under a deposit row's amount. A deposit no sweep can move leads, because what it asks
 * of the user outranks where it sits; anything still moving is simply pending; the settled phases
 * that never credited say which one they are, and a claimed deposit carries no badge at all.
 *
 * Keyed on the phase alone, in the words `depositStatus` uses for the same phases, so the row and
 * the detail sheet cannot read differently — including on a record whose recovery this device has no
 * key for, which still needs one.
 */
export function depositRowStatusLabel(
  record: Pick<SIPADepositRecord, "phase">,
): StatusLabel | undefined {
  if (record.phase === "recoverable") return "Needs recovery"
  if (!isSettledSipaPhase(record.phase)) return "Pending"
  if (record.phase === "recovered") return "Recovered"
  if (record.phase === "failed") return "Cancelled"
  return undefined
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
 * The badge under a row's amount. An in-flight or failed transaction says so first — nothing about a
 * link's lifecycle is settled while the transaction that created it isn't. Past that, a creator
 * paylink row reads out where its link stands, in the same words the detail modal uses.
 *
 * That standing comes from stored flags and the clock alone (`paylinkStatusFor`): the feed reads no
 * chain, so "Expired" is `untilClaimable` against now, and "Claimed" means this device saw the claim.
 */
export function activityStatusLabel(
  status: TransactionStatus,
  paylinkStatus: PaylinkStatusKind | undefined,
): StatusLabel | undefined {
  if (status === "pending") return "Pending"
  if (status === "failed") return "Failed"
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
// reading "Refunded", carrying both hashes — is the whole round trip in one row.
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

function paylinkLabel(action: string): string {
  return action === PaylinkActionEnum.PAY ? "Sent via paylink" : "Received via paylink"
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
 * the wall clock).
 */
export function buildActivityRows(
  transactions: Transaction[],
  directory: TxContactDirectory,
  nowSec?: number,
): ActivityRowView[] {
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

      let contact: ContactRow | undefined
      let counterparty: string
      let counterpartyTag: string | undefined
      if (isPaylink) {
        counterparty = paylinkLabel(tx.action)
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

      const paylinkStatus = isPaylinkCreate
        ? paylinkStatusFor(tx as PaylinkTransaction, nowSec ?? Math.floor(Date.now() / 1000))
        : undefined
      const creatorAction =
        paylinkStatus && nowSec != null
          ? creatorLinkAction(tx as PaylinkTransaction, { nowSec, liveStatus: paylinkStatus })
          : null
      const outgoing = isSend || tx.action === PaylinkActionEnum.PAY
      return {
        id: tx.txHash || tx.queueId || String(tx.timestamp),
        counterparty,
        contact,
        counterpartyTag: contact?.addressKind === "aztec-l2" ? contact.tag : counterpartyTag,
        avatarIcon: isPaylink ? "link" : tx.status === "pending" ? "clock-outline" : undefined,
        // A tx still waiting for the network says so where its time will go.
        timestamp:
          tx.status === "pending"
            ? outgoing
              ? "Sending…"
              : "Receiving…"
            : `${formatDateLabel(tx.timestamp)}, ${formatTimeLabel(tx.timestamp)}`,
        timestampMs: tx.timestamp,
        // Scanned rows carry no price; the wallet's assets are USD-pegged, so 1:1.
        amount: formatFiat(tx.token?.amount ?? 0, tx.token?.price || 1, outgoing ? "-" : "+"),
        statusLabel: activityStatusLabel(tx.status, paylinkStatus),
        status: tx.status,
        error: tx.status === "failed" && tx.error === INTERRUPTED_SEND_ERROR ? tx.error : undefined,
        txHash: tx.txHash || undefined,
        note: "memo" in tx && typeof tx.memo === "string" && tx.memo ? tx.memo : undefined,
        paylink,
        paylinkStatus,
        refundTxHash:
          isPaylinkCreate && "refundTxHash" in tx && typeof tx.refundTxHash === "string"
            ? tx.refundTxHash
            : undefined,
        creatorAction: creatorAction ?? undefined,
        paylinkRow: isPaylinkCreate ? (tx as PaylinkTransaction) : undefined,
      }
    })
}
