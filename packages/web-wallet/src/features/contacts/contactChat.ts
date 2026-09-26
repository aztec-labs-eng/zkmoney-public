/**
 * Pure assembly glue for the contact detail payments chat (R15): maps a stored contact and the web
 * data sources onto the shared `buildChatMessages`, and maps chat roles onto bubble presentation.
 * UI-free so vitest covers it without DOM.
 */
import {
  buildChatMessages,
  contactRowFromEntry,
  isPaymentContactEntry,
  type ChatMessage,
  type ChatMessageRole,
  type Contact,
  type PaymentRequest,
  type SIPADepositRecord,
  type SelectedContact,
  type Transaction,
  type WithdrawalRecord,
} from "@obsidion/front-core"

/** Chat identity for a stored contact. Pending-handshake rows have no payable address — they
 *  select tag-only, so the chat stays empty until the handshake completes. */
export function selectedContactOf(entry: Contact): SelectedContact {
  if (isPaymentContactEntry(entry)) {
    const row = contactRowFromEntry(entry)
    return {
      id: row.id,
      name: row.name,
      tag: row.tag,
      address: row.address,
      addressKind: row.addressKind,
      provenance: row.provenance,
    }
  }
  const tag = entry.tag ?? entry.name
  return { id: tag, name: entry.name, tag, addressKind: "aztec-l2" }
}

/** The web data sources the contact chat merges. Paylink rows arrive through `transactions`. */
export interface ContactChatSources {
  transactions?: Transaction[]
  requests?: PaymentRequest[]
  sipaDeposits?: SIPADepositRecord[]
  withdrawals?: WithdrawalRecord[]
}

export function buildContactChat(
  entry: Contact,
  sources: ContactChatSources,
  txUrl?: (txHash: string) => string,
): ChatMessage[] {
  return buildChatMessages(
    selectedContactOf(entry),
    {
      transactions: sources.transactions,
      requests: sources.requests,
      bridge: { sipaDeposits: sources.sipaDeposits, withdrawals: sources.withdrawals },
    },
    txUrl,
  )
}

/** The record a chat bubble opens. */
export type ChatMessageSource =
  | { kind: "request"; id: string }
  | { kind: "transaction"; transaction: Transaction }
  | { kind: "deposit"; record: SIPADepositRecord }
  | { kind: "withdrawal"; record: WithdrawalRecord }

/**
 * Resolves a bubble to its record by id, never by role: a fulfilled request stands in as a
 * `received-confirmed` bubble until its transfer row arrives, so the role alone would send it
 * looking for a transaction that doesn't exist.
 */
export function chatMessageSource(
  message: ChatMessage,
  sources: ContactChatSources,
): ChatMessageSource | undefined {
  const id = message.id
  if (sources.requests?.some((r) => r.id === id)) return { kind: "request", id }
  const transaction = sources.transactions?.find(
    (tx) => (tx.txHash || tx.queueId || String(tx.timestamp)) === id,
  )
  if (transaction) return { kind: "transaction", transaction }
  const deposit = sources.sipaDeposits?.find((d) => d.sipaAddress === id)
  if (deposit) return { kind: "deposit", record: deposit }
  const withdrawal = sources.withdrawals?.find((w) => (w.l2TxHash ?? w.localId) === id)
  if (withdrawal) return { kind: "withdrawal", record: withdrawal }
  return undefined
}

/** Bubble presentation for a chat role. */
export interface BubbleView {
  side: "left" | "right"
  label: string
  /** Status-pill icon (web-ds Icon name). */
  icon: "reply" | "forward" | "clock" | "clock-outline" | "reply-slash" | "check"
  /** Red tint (declined / failed). */
  error: boolean
  /** Strikethrough amount (rejected request, failed/cancelled transfer). */
  struck: boolean
  /**
   * Delivery mark beside the time, mirroring the tx's own lifecycle: a spinner while the proof
   * runs, one tick once it is in the mempool, two once mined.
   */
  tick: "none" | "proving" | "sent" | "mined"
  /** Open request: gold pill, unsigned amount, action buttons instead of a time. */
  request: boolean
  /** Request the user has paid: green pill, unsigned amount, no arrow — distinct from a transfer. */
  settled: boolean
}

export function bubbleViewOf(role: ChatMessageRole): BubbleView {
  const base = {
    error: false,
    struck: false,
    tick: "none",
    request: false,
    settled: false,
  } as const
  if (role === "request-out")
    return { ...base, side: "right", label: "Owes you", icon: "clock", request: true }
  if (role === "request-in")
    return { ...base, side: "left", label: "You owe", icon: "clock", request: true }
  if (role === "request-paid")
    return { ...base, side: "left", label: "You paid", icon: "check", settled: true }
  if (role === "request-declined")
    return {
      ...base,
      side: "left",
      label: "Declined",
      icon: "reply-slash",
      error: true,
      struck: true,
    }
  const side = role.startsWith("sent-") ? "right" : "left"
  const icon = side === "right" ? "forward" : "reply"
  const verb = side === "right" ? "Sent" : "Received"
  if (role.endsWith("-proving"))
    return { ...base, side, label: "Pending", icon: "clock-outline", tick: "proving" }
  if (role.endsWith("-pending"))
    return { ...base, side, label: "Pending", icon: "clock-outline", tick: "sent" }
  if (role.endsWith("-failed") || role.endsWith("-cancelled"))
    return {
      ...base,
      side,
      label: role.endsWith("-failed") ? "Failed" : "Cancelled",
      icon: "reply-slash",
      error: true,
      struck: true,
    }
  return { ...base, side, label: verb, icon, tick: "mined" }
}
