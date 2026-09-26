import { QueueStatus } from "@obsidion/sdk"
import type { Transaction } from "src/types"
import { depositAmounts, type DepositAmounts } from "./services/deposits/depositAmounts"
import type { SIPADepositPhase, SIPADepositRecord } from "./services/deposits/SIPADepositStore"
import type { WithdrawalRecord } from "./services/bridge/types"
import type { PaymentRequest } from "./storages/RequestStorage.js"
import { withoutAnsweredRequests } from "../utils/requestRows"

export interface SelectedContact {
  id: string
  name: string
  tag: string
  address?: string
  addressKind?: "aztec-l2" | "ethereum-l1"
  provenance?: "deposit-attested" | "saved-recipient"
}

/** `proving` is a send with no txHash yet — nothing is on-chain, so it is not even in a mempool. */
type ChatTransferStatus = "proving" | "pending" | "confirmed" | "failed" | "cancelled"

export type ChatMessageRole =
  | "received-confirmed"
  | "received-proving"
  | "received-pending"
  | "received-failed"
  | "received-cancelled"
  | "sent-confirmed"
  | "sent-proving"
  | "sent-pending"
  | "sent-failed"
  | "sent-cancelled"
  | "request-out"
  | "request-in"
  | "request-paid"
  | "request-declined"

/** One chat bubble. */
export interface ChatMessage {
  id: string
  /** Date label used as the section separator, e.g. "03 February". */
  dateLabel: string
  /** Time label inside the bubble, e.g. "11:15" or "Pending". */
  timeLabel: string
  /** Pre-formatted signed amount, e.g. "+$25.23" / "-$23.57". */
  amount: string
  role: ChatMessageRole
  /** Block-explorer URL for the message's tx hash. Unset when `id` isn't an
   * on-chain tx hash (requests, paylinks, SIPA deposits keyed by address). */
  explorerUrl?: string
}

/** Chat-header identity. */
export interface ContactChatPayload {
  id: string
  name: string
  tag: string
  address?: string
  addressKind?: "aztec-l2" | "ethereum-l1"
  provenance?: "deposit-attested" | "saved-recipient"
  /** Two hex colors for the gradient avatar (top-leading → bottom-trailing). */
  avatarColorHex: [string, string]
}

export interface PaylinkChatItem {
  id: string
  contactTag?: string
  counterpartyAddress?: string
  amount: number | string
  direction: "outgoing" | "incoming"
  status: ChatTransferStatus
  createdAt: number
}

export interface BuildChatMessageSources {
  transactions?: Transaction[]
  requests?: PaymentRequest[]
  bridge?: {
    /** SIPA-path deposits; self-initiated records match by sender walletAddress. */
    sipaDeposits?: SIPADepositRecord[]
    /** L2→L1 withdrawals; match by recipient L1 address. */
    withdrawals?: WithdrawalRecord[]
  }
  paylinks?: PaylinkChatItem[]
}

export function buildContactPayload(
  selectedContact: SelectedContact | null,
  avatarColorsForKey: (key: string) => [string, string],
): ContactChatPayload | null {
  if (!selectedContact) return null

  const isL1 = selectedContact.addressKind === "ethereum-l1"
  return {
    id: selectedContact.id,
    name: selectedContact.name,
    tag: isL1 ? selectedContact.address ?? selectedContact.tag : `@${selectedContact.tag}.zk.money`,
    address: selectedContact.address,
    addressKind: selectedContact.addressKind ?? "aztec-l2",
    provenance: selectedContact.provenance,
    avatarColorHex: avatarColorsForKey(isL1 ? selectedContact.id : selectedContact.tag),
  }
}

export function buildChatMessages(
  selectedContact: SelectedContact | null,
  sources: BuildChatMessageSources = {},
  /** L2 explorer link builder. Omit to render without explorer links. */
  txUrl?: (txHash: string) => string,
): ChatMessage[] {
  if (!selectedContact) return []

  const contactAddress = selectedContact.address
  const transactions = sources.transactions ?? []
  const requests = withoutAnsweredRequests(sources.requests ?? [], transactions)
  const bridgeHistory = sources.bridge ?? {}
  const paylinks = sources.paylinks ?? []
  const messages: Array<ChatMessage & { _ts: number }> = []

  if (selectedContact.addressKind === "ethereum-l1") {
    if (!contactAddress) return []
    const contactAddressLower = contactAddress.toLowerCase()

    for (const deposit of bridgeHistory.sipaDeposits ?? []) {
      if (deposit.walletAddress?.toLowerCase() !== contactAddressLower) continue
      // resolved: the address was minted but nothing observable happened yet —
      // hidden like the legacy awaiting_funds until funding/broadcast lands.
      if (deposit.phase === "resolved") continue
      const status = sipaDepositStatus(deposit)
      const amounts = depositAmounts(deposit)
      messages.push({
        id: deposit.sipaAddress,
        dateLabel: formatDateLabel(deposit.startTime),
        timeLabel: sipaTimeLabel(deposit, status),
        amount: sipaDepositAmount(deposit, amounts),
        role: transferRole("received", status),
        _ts: deposit.startTime,
      })
    }

    for (const withdrawal of bridgeHistory.withdrawals ?? []) {
      if (withdrawal.recipient?.toLowerCase() !== contactAddressLower) continue
      const status = bridgeWithdrawalStatus(withdrawal)
      messages.push({
        id: withdrawal.l2TxHash ?? withdrawal.localId,
        dateLabel: formatDateLabel(withdrawal.startTime),
        timeLabel: withdrawalTimeLabel(withdrawal, status),
        amount: `-$${formatAmount(withdrawal.amount)}`,
        role: transferRole("sent", status),
        // The detail sheet displays `id` as the Transaction ID — the L2 burn
        // tx — so the link points at the L2 explorer, not the L1 release tx.
        explorerUrl: withdrawal.l2TxHash && txUrl ? txUrl(withdrawal.l2TxHash) : undefined,
        _ts: withdrawal.startTime,
      })
    }

    messages.sort((a, b) => a._ts - b._ts)
    return messages.map(({ _ts: _, ...rest }) => rest)
  }

  const renderedTxHashes = new Set<string>()

  if (contactAddress) {
    const filtered = transactions.filter((tx: Transaction) => {
      if (!("token" in tx) || !tx.token) return false
      // A cancel aborted during prove leaves detailedStatus=CANCELLED with an
      // empty txHash. The send never reached chain, so there's nothing to show.
      if (tx.detailedStatus === QueueStatus.CANCELLED && !tx.txHash) return false
      const isSend = tx.action === "send"
      const toAddr = isSend && "to" in tx ? (tx as any).to : undefined
      const fromAddr = !isSend && "from" in tx ? (tx as any).from : undefined
      // XMTP receives write `from` as the sender's tag and the canonical L2
      // address as `senderL2Address` — match the latter so they land in the
      // matching contact's chat history.
      const senderL2 = !isSend && "senderL2Address" in tx ? (tx as any).senderL2Address : undefined
      return toAddr === contactAddress || fromAddr === contactAddress || senderL2 === contactAddress
    })

    for (const tx of filtered) {
      const isSend = tx.action === "send"
      const status = transactionStatus(tx)
      const role = transferRole(isSend ? "sent" : "received", status)
      const fiat = "token" in tx ? tx.token?.amount ?? 0 : 0
      const sign = isSend ? "-" : "+"
      if (tx.txHash) renderedTxHashes.add(tx.txHash.toLowerCase())
      messages.push({
        id: tx.txHash || tx.queueId || String(tx.timestamp),
        dateLabel: formatDateLabel(tx.timestamp),
        timeLabel: transferTimeLabel(status, tx.timestamp),
        amount: `${sign}$${fiat.toFixed(2)}`,
        role,
        explorerUrl: tx.txHash && txUrl ? txUrl(tx.txHash) : undefined,
        _ts: tx.timestamp,
      })
    }
  }

  for (const paylink of paylinks) {
    if (!paylinkMatchesContact(paylink, selectedContact)) continue
    const isOutgoing = paylink.direction === "outgoing"
    messages.push({
      id: paylink.id,
      dateLabel: formatDateLabel(paylink.createdAt),
      timeLabel: transferTimeLabel(paylink.status, paylink.createdAt),
      amount: `${isOutgoing ? "-" : "+"}$${formatPaylinkAmount(paylink.amount)}`,
      role: transferRole(isOutgoing ? "sent" : "received", paylink.status),
      _ts: paylink.createdAt,
    })
  }

  const tag = selectedContact.tag.toLowerCase()
  for (const r of requests) {
    if (r.contactTag.toLowerCase() !== tag) continue

    // Map the request's lifecycle to a bubble. Outgoing requests (the ones the
    // user creates) render pending + terminal states, driven by RequestStorage
    // status: a decline arrives over XMTP; a fulfillment is joined from the verified
    // transfer's on-chain `meta`. Incoming requests render only while
    // pending — once the user pays, the send transaction itself renders the
    // payment (so a fulfilled incoming row would double-show), and a declined
    // incoming request is hidden.
    let role: ChatMessageRole | null = null
    let amount = `${r.direction === "outgoing" ? "-" : "+"}$${r.amount.toFixed(2)}`
    if (r.status === "pending") {
      role = r.direction === "outgoing" ? "request-out" : "request-in"
    } else if (r.direction === "outgoing" && r.status === "fulfilled") {
      // The contact paid the request → the user received the funds (Received ✓).
      // The fulfilling transfer renders as its own transaction bubble (same tx
      // hash) and takes precedence — drop the request row when it is rendered.
      if (r.fulfillmentTxHash && renderedTxHashes.has(r.fulfillmentTxHash.toLowerCase())) continue
      role = "received-confirmed"
      amount = `+$${r.amount.toFixed(2)}`
    } else if (r.direction === "incoming" && r.status === "fulfilled") {
      role = "request-paid"
      amount = `$${r.amount.toFixed(2)}`
    } else if (r.direction === "outgoing" && r.status === "declined") {
      // The contact rejected the request (strikethrough "Rejected" bubble).
      role = "request-declined"
      amount = `$${r.amount.toFixed(2)}`
    }
    // cancelled requests and declined incoming requests don't surface in the chat.
    if (!role) continue

    messages.push({
      id: r.id,
      dateLabel: formatDateLabel(r.createdAt),
      timeLabel: formatTimeLabel(r.createdAt),
      amount,
      role,
      _ts: r.createdAt,
    })
  }

  messages.sort((a, b) => a._ts - b._ts)
  return messages.map(({ _ts: _, ...rest }) => rest)
}

function bridgeWithdrawalStatus(record: WithdrawalRecord): ChatTransferStatus {
  if (record.phase === "failed") return "failed"
  // recovered = the swap never ran and the DAI went to an L1 address of the user's choosing.
  if (record.phase === "recovered") return "cancelled"
  return record.phase === "done" ? "confirmed" : "pending"
}

function withdrawalTimeLabel(record: WithdrawalRecord, status: ChatTransferStatus): string {
  if (record.phase === "recoverable") return "Needs recovery"
  if (record.phase === "recovered") return "Recovered"
  return transferTimeLabel(status, record.startTime)
}

/**
 * Phases whose funds never reach the L2 balance: no sweep can move a `recoverable` deposit, and a
 * `recovered` one already went back out on L1.
 */
function neverCreditsL2(phase: SIPADepositPhase): boolean {
  return phase === "recoverable" || phase === "recovered"
}

/** The amount a deposit shows before any read has settled its figure. */
export const DETECTING_AMOUNT = "Detecting amount\u2026"

/**
 * The figure a deposit's bubble carries. The "+" marks a credit, so only a net on its way into the
 * L2 balance gets one; everything else shows the whole sum that sits at (or left) the deposit
 * address, unsigned. A gross of zero on a phase that still credits means the L1 amount is not read
 * yet, never a real zero.
 */
function sipaDepositAmount(deposit: SIPADepositRecord, amounts: DepositAmounts): string {
  const gross = `$${formatAmount(amounts.grossDisplay)}`
  if (neverCreditsL2(deposit.phase)) return gross
  if ((amounts.feeKnown || deposit.netAmount != null) && amounts.netAtomic > 0n)
    return `+$${formatAmount(amounts.netDisplay)}`
  return amounts.grossAtomic > 0n ? gross : DETECTING_AMOUNT
}

function sipaDepositStatus(record: SIPADepositRecord): ChatTransferStatus {
  if (record.phase === "failed") return "failed"
  if (record.phase === "claimed") return "confirmed"
  // recovered = the funds went back out to an L1 wallet and the L2 balance was never credited.
  if (record.phase === "recovered") return "cancelled"
  // recoverable stays pending: the funds still sit at the deposit address awaiting the user's recovery.
  return "pending"
}

function sipaTimeLabel(record: SIPADepositRecord, status: ChatTransferStatus): string {
  // A recoverable deposit is permanently stuck for the sweep path (e.g. at or
  // below the fee floor) — "Pending" would promise progress that will never come.
  if (record.phase === "recoverable") return "Needs recovery"
  if (record.phase === "recovered") return "Recovered"
  return transferTimeLabel(status, record.startTime)
}

function transactionStatus(tx: Transaction): ChatTransferStatus {
  // CANCELLED detailedStatus shadows the "failed" status and renders as "Cancelled".
  if (tx.detailedStatus === QueueStatus.CANCELLED) {
    return "cancelled"
  }
  if (tx.status === "failed" || tx.detailedStatus === QueueStatus.FAILED) {
    return "failed"
  }
  if (tx.status === "pending" || tx.detailedStatus === QueueStatus.PENDING) {
    // The hash is minted from the proven tx just before submission, so a pending row without one
    // has not reached a mempool yet — the difference the chat draws as a spinner vs a single tick.
    return tx.txHash ? "pending" : "proving"
  }
  return "confirmed"
}

function transferRole(direction: "sent" | "received", status: ChatTransferStatus): ChatMessageRole {
  return `${direction}-${status}` as ChatMessageRole
}

function transferTimeLabel(status: ChatTransferStatus, timestamp: number): string {
  if (status === "proving") return "Proving"
  if (status === "pending") return "Pending"
  if (status === "failed") return "Failed"
  if (status === "cancelled") return "Cancelled"
  return formatTimeLabel(timestamp)
}

function paylinkMatchesContact(
  paylink: PaylinkChatItem,
  selectedContact: SelectedContact,
): boolean {
  if (paylink.contactTag?.toLowerCase() === selectedContact.tag.toLowerCase()) return true
  if (!paylink.counterpartyAddress || !selectedContact.address) return false
  return paylink.counterpartyAddress.toLowerCase() === selectedContact.address.toLowerCase()
}

function formatAmount(value: string): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "0.00"
}

function formatPaylinkAmount(value: number | string): string {
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(2) : "0.00"
  return formatAmount(value)
}

export function formatDateLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  ) {
    return "Today"
  }
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return "Yesterday"
  }
  const day = date.getDate().toString().padStart(2, "0")
  const month = date.toLocaleString("en-US", { month: "long" })
  return `${day} ${month}`
}

export function formatTimeLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const hh = date.getHours().toString().padStart(2, "0")
  const mm = date.getMinutes().toString().padStart(2, "0")
  return `${hh}:${mm}`
}
