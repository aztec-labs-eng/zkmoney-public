import { parseAmount } from "../../ui/format"
/**
 * Pure logic for the contact payment-request flow (U12): outgoing-row construction, best-effort
 * XMTP announce, and the decline transition. Deps are injected so vitest covers it without a
 * client. Delivery never blocks or invalidates the local row — the store is authoritative.
 */
import { Fr } from "@aztec/aztec.js/fields"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { parseUnits } from "viem"
import type { PaymentRequest, RequestBroadcaster, RequestStorage } from "@obsidion/front-core"

/** Mint a pending outgoing contact-request row, or null when the amount doesn't parse positive. */
export function newOutgoingRequest(
  contactTag: string,
  amountText: string,
  decimals: number,
  note?: string,
): PaymentRequest | null {
  const amount = parseAmount(amountText)
  if (!Number.isFinite(amount) || amount <= 0) return null
  let amountAtomic: string
  try {
    // parseUnits over the raw text keeps exact base units (no float round-trip, no 1e-7 notation).
    amountAtomic = parseUnits(amountText.trim(), decimals).toString()
  } catch {
    return null
  }
  return {
    // A field: the fulfilling send carries it in the on-chain `Transfer.meta`.
    id: Fr.random().toString(),
    contactTag,
    amount,
    asset: WALLET_TOKEN_SYMBOL,
    direction: "outgoing",
    status: "pending",
    createdAt: Date.now(),
    kind: "contact",
    amountAtomic,
    tokenDecimals: decimals,
    note: note?.trim() || undefined,
  }
}

export interface AnnounceDeps {
  broadcaster: Pick<RequestBroadcaster, "announce">
  /** Registry tag → published XMTP address; null when the tag has no binding. */
  resolveXmtpAddress(tag: string): Promise<string | null>
  requesterTag: string
  networkId: string
  token: { address: string; symbol?: string; decimals: number }
}

/** Best-effort announce of a persisted outgoing row. Never throws. */
export async function announceOutgoingRequest(
  request: PaymentRequest,
  deps: AnnounceDeps,
): Promise<void> {
  try {
    const xmtpAddress = await deps.resolveXmtpAddress(request.contactTag)
    if (!xmtpAddress) return
    await deps.broadcaster.announce({
      recipientXmtpAddress: xmtpAddress,
      requestId: request.id,
      requesterTag: deps.requesterTag,
      amountAtomic:
        request.amountAtomic ??
        BigInt(Math.round(request.amount * 10 ** deps.token.decimals)).toString(),
      token: deps.token,
      networkId: deps.networkId,
      note: request.note,
      expiresAt: request.expiresAt,
    })
  } catch (err) {
    console.warn("[requestFlow] announce failed", err)
  }
}

export interface DeclineDeps {
  store: Pick<RequestStorage, "findById" | "applyStatus">
  /** Null when no leader XMTP client exists — the local flip still applies. */
  broadcaster: Pick<RequestBroadcaster, "signalDeclined"> | null
  resolveXmtpAddress(tag: string): Promise<string | null>
  networkId: string
}

/**
 * Decline an incoming request: the store's monotonic guard applies the status (a fulfilled or
 * already-declined row never regresses), then the requester is signalled best-effort over XMTP.
 * Returns whether the local flip applied.
 */
export async function declineIncomingRequest(id: string, deps: DeclineDeps): Promise<boolean> {
  const target = await deps.store.findById(id)
  const { applied } = await deps.store.applyStatus(id, "declined")
  if (!applied) return false
  if (!deps.broadcaster || !target?.contactTag) return true
  try {
    const xmtpAddress = await deps.resolveXmtpAddress(target.contactTag)
    if (!xmtpAddress) return true
    await deps.broadcaster.signalDeclined({
      recipientXmtpAddress: xmtpAddress,
      requestId: id,
      networkId: target.networkId ?? deps.networkId,
    })
  } catch (err) {
    console.warn("[requestFlow] declined signal failed", err)
  }
  return true
}

/**
 * Payer side of a send that fulfilled a request: flip the local incoming row (a link request
 * usually has none — best-effort). The requester's row flips on their side from the send's
 * on-chain `Transfer.meta`; nothing is signalled.
 */
export async function markRequestPaidLocally(
  id: string,
  txHash: string,
  store: Pick<RequestStorage, "applyStatus">,
): Promise<boolean> {
  const { applied } = await store.applyStatus(id, "fulfilled", txHash)
  return applied
}
