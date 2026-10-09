/**
 * Payment-request → activity-feed row projection. Platforms decorate the
 * rows with their own action sets and avatars. Fulfilled outgoing links keep a paid-link row;
 * the matching verified receive is omitted from Activity and resolved only for "Paid by".
 */
import type { ContactRow } from "../hooks/useContactsDirectory"
import { resolveContactForTx, type TxContactDirectory } from "../core/txContactResolution"
import { depositAmounts } from "../core/services/deposits/depositAmounts"
import type { SIPADepositRecord } from "../core/services/deposits/SIPADepositStore"
import type { PaymentRequest } from "../core/storages/RequestStorage"
import type { Transaction } from "../types/transactions"
import { isZeroAddress, validateAddress } from "./validate"

export interface RequestRowView {
  id: string
  kind: "incoming" | "outgoingContact" | "outgoingLink"
  counterparty: string
  /** Bare tag — drives the gradient avatar and contact navigation. Unset for link requests. */
  contactTag?: string
  statusLabel: "You owe" | "Owes you" | "Unpaid" | "Payment detected"
  /** Signed fiat, or "Any amount" for a zero-amount link request. */
  amount: string
  /** Raw USD amount — prefill for a fulfilling send. */
  amountValue: number
  timestampMs: number
  /** Feed-filter direction: money would leave on an incoming request, arrive on an outgoing one. */
  direction: "in" | "out"
}

function usd(amount: number, sign: "+" | "-"): string {
  return `${sign}$${amount.toFixed(2)}`
}

function isExpired(request: PaymentRequest, now: number): boolean {
  return request.expiresAt != null && now > request.expiresAt
}

export interface PaidLinkRowView {
  id: string
  counterparty: string
  amount: string
  timestampMs: number
  fulfillmentTxHash?: string
}

export type PaidLinkSipaDeposit = Pick<
  SIPADepositRecord,
  "sipaAddress" | "startTime" | "endTime" | "amount" | "netAmount" | "fee"
>

function findFulfillingReceive(
  fulfillmentTxHash: string | undefined,
  transactions: ReadonlyArray<Transaction>,
): Transaction | undefined {
  const hash = fulfillmentTxHash?.toLowerCase()
  if (!hash) return undefined
  return transactions.find((row) => row.action === "receive" && row.txHash?.toLowerCase() === hash)
}

/** What actually arrived: the verified receive, else the deposit net, else the requested amount. */
function paidAmount(
  request: PaymentRequest,
  receive: Transaction | undefined,
  deposit: PaidLinkSipaDeposit | undefined,
): string {
  if (receive && "token" in receive && receive.token) {
    return usd(receive.token.amount * (receive.token.price || 1), "+")
  }
  if (deposit) {
    const net = Number(depositAmounts(deposit).netDisplay)
    if (net > 0) return usd(net, "+")
  }
  return request.amount > 0 ? usd(request.amount, "+") : "Any amount"
}

/** Fulfilled outgoing link requests — the Activity stand-in for the collapsed receive / SIPA deposit. */
export function buildPaidLinkRows(
  requests: PaymentRequest[],
  sipaDeposits: ReadonlyArray<PaidLinkSipaDeposit>,
  transactions: ReadonlyArray<Transaction> = [],
): PaidLinkRowView[] {
  const depositsByAddress = new Map(sipaDeposits.map((d) => [d.sipaAddress.toLowerCase(), d]))
  return requests
    .filter((r) => r.direction === "outgoing" && r.kind === "link" && r.status === "fulfilled")
    .map((r) => {
      const deposit = r.sipaAddress ? depositsByAddress.get(r.sipaAddress.toLowerCase()) : undefined
      const receive = findFulfillingReceive(r.fulfillmentTxHash, transactions)
      return {
        id: r.id,
        counterparty: "Requested via link",
        amount: paidAmount(r, receive, deposit),
        timestampMs: deposit ? deposit.endTime ?? deposit.startTime : r.createdAt,
        fulfillmentTxHash: r.fulfillmentTxHash,
      }
    })
}

/** What the pending-row funding probe reads off a linked SIPA deposit. */
export type RequestLinkedDeposit = Pick<SIPADepositRecord, "sipaAddress" | "phase" | "amount">

// Any evidence of funds counts; "fulfilled" stays gated on `claimed` (sipaRequestFulfillment).
function depositShowsFunds(deposit: RequestLinkedDeposit): boolean {
  return (
    Number(deposit.amount) > 0 || (deposit.phase !== "broadcast" && deposit.phase !== "resolved")
  )
}

export function buildRequestRows(
  requests: PaymentRequest[],
  now: number,
  linkedDeposits: ReadonlyArray<RequestLinkedDeposit> = [],
): RequestRowView[] {
  const depositsByAddress = new Map(linkedDeposits.map((d) => [d.sipaAddress.toLowerCase(), d]))
  return requests
    .filter((r) => r.status === "pending" && !isExpired(r, now))
    .map((r): RequestRowView => {
      const base = { id: r.id, timestampMs: r.createdAt, amountValue: r.amount }
      if (r.direction === "incoming") {
        return {
          ...base,
          kind: "incoming",
          counterparty: `@${r.contactTag}`,
          contactTag: r.contactTag,
          statusLabel: "You owe",
          amount: usd(r.amount, "-"),
          direction: "out",
        }
      }
      if (r.kind === "link") {
        // The funding→claimed window otherwise renders identically to "nobody has paid" — the
        // deposit row is suppressed for link SIPAs and the paid row waits on the claim.
        const deposit = r.sipaAddress
          ? depositsByAddress.get(r.sipaAddress.toLowerCase())
          : undefined
        return {
          ...base,
          kind: "outgoingLink",
          counterparty: "Requested via link",
          statusLabel: deposit && depositShowsFunds(deposit) ? "Payment detected" : "Unpaid",
          amount: r.amount > 0 ? usd(r.amount, "+") : "Any amount",
          direction: "in",
        }
      }
      return {
        ...base,
        kind: "outgoingContact",
        counterparty: `@${r.contactTag}`,
        contactTag: r.contactTag,
        statusLabel: "Owes you",
        amount: usd(r.amount, "+"),
        direction: "in",
      }
    })
}

/**
 * Drop pending incoming requests a send has answered: the send row shows the payment, so the
 * request must not keep offering Decline / Send beside it. Only a failed send lets it reappear.
 * A landed send normally marks its request fulfilled; this covers the one the wallet stopped
 * watching mid-flight, which nothing marks because `fulfilled` is terminal and the chain decides.
 */
export function withoutAnsweredRequests<
  T extends Pick<PaymentRequest, "id" | "direction" | "status">,
>(
  requests: readonly T[],
  transactions: ReadonlyArray<Pick<Transaction, "action" | "status"> & { requestId?: string }>,
): T[] {
  const answered = new Set<string>()
  for (const tx of transactions) {
    if (tx.action === "send" && tx.status !== "failed" && tx.requestId) {
      answered.add(tx.requestId.toLowerCase())
    }
  }
  if (answered.size === 0) return [...requests]
  return requests.filter(
    (r) =>
      !(r.direction === "incoming" && r.status === "pending" && answered.has(r.id.toLowerCase())),
  )
}

/** Lowercased tags of the L2 contacts the user added, not of senders added from a transfer. */
export function approvedContactTags(contacts: readonly ContactRow[]): Set<string> {
  return new Set(
    contacts.flatMap((c) =>
      c.addressKind === "aztec-l2" && !c.autoAdded ? [c.tag.toLowerCase()] : [],
    ),
  )
}

/** An incoming request from someone outside the contact book: kept out of Activity and Home. */
export function isFromNonContact(
  request: Pick<PaymentRequest, "direction" | "contactTag">,
  contactTags: ReadonlySet<string>,
): boolean {
  return request.direction === "incoming" && !contactTags.has(request.contactTag.toLowerCase())
}

/** The inbox for requests from non-contacts: pending, unexpired, unanswered, newest first. */
export function nonContactInbox(
  requests: readonly PaymentRequest[],
  transactions: Parameters<typeof withoutAnsweredRequests>[1],
  contactTags: ReadonlySet<string>,
  now: number,
): PaymentRequest[] {
  return withoutAnsweredRequests(requests, transactions)
    .filter((r) => r.status === "pending" && !isExpired(r, now) && isFromNonContact(r, contactTags))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Drop verified receives that fulfilled a paid request link — the paid-link row is the canonical entry. */
export function withoutPaidLinkReceives<T extends { action?: string; txHash?: string }>(
  transactions: readonly T[],
  requests: ReadonlyArray<
    Pick<PaymentRequest, "direction" | "kind" | "status" | "fulfillmentTxHash">
  >,
): T[] {
  const hashes = new Set<string>()
  for (const request of requests) {
    if (
      request.direction !== "outgoing" ||
      request.kind !== "link" ||
      request.status !== "fulfilled"
    ) {
      continue
    }
    const hash = request.fulfillmentTxHash?.toLowerCase()
    if (hash) hashes.add(hash)
  }
  return transactions.filter(
    (tx) => tx.action !== "receive" || !tx.txHash || !hashes.has(tx.txHash.toLowerCase()),
  )
}

export interface PaidLinkPayer {
  displayName: string
  contact?: ContactRow
}

function payerDisplayName(
  from: string | undefined,
  contact: ContactRow | undefined,
): string | undefined {
  if (contact) return contact.name
  if (!from || isZeroAddress(from) || validateAddress(from)) return undefined
  return from.startsWith("@") ? from : `@${from}`
}

/** Resolve who paid a fulfilled request link from its matching verified receive. */
export function payerForPaidLink(
  request: Pick<PaymentRequest, "fulfillmentTxHash">,
  transactions: ReadonlyArray<Transaction>,
  directory: TxContactDirectory,
): PaidLinkPayer | undefined {
  const tx = findFulfillingReceive(request.fulfillmentTxHash, transactions)
  if (!tx) return undefined
  const from = "from" in tx && typeof tx.from === "string" ? tx.from : undefined
  const senderL2 =
    "senderL2Address" in tx && typeof tx.senderL2Address === "string"
      ? tx.senderL2Address
      : undefined
  const contact = resolveContactForTx(from ?? "", senderL2, directory)
  const displayName = payerDisplayName(from, contact)
  if (!displayName) return undefined
  return { displayName, contact }
}
