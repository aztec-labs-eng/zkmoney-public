import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import type { StoredRequest } from "../engine/requests.js"
import type { IncomingRequestInput } from "./requestReceiverTypes.js"

/**
 * The receiver-side XMTP request packet mapped to a stored request row. It is dated by its send
 * time, clamped to `now` so a skewed sender clock cannot date it ahead.
 */
export function incomingRequestToRow(input: IncomingRequestInput, now: number): StoredRequest {
  const amount = Number(input.amountAtomic) / 10 ** input.decimals
  return {
    id: input.requestId,
    contactTag: input.requesterTag,
    amount: Number.isFinite(amount) ? amount : 0,
    asset: input.tokenSymbol ?? WALLET_TOKEN_SYMBOL,
    direction: "incoming",
    status: "pending",
    createdAt: input.sentAt !== undefined && input.sentAt > 0 ? Math.min(input.sentAt, now) : now,
    kind: "contact",
    tokenAddress: input.tokenAddress,
    amountAtomic: input.amountAtomic,
    tokenDecimals: input.decimals,
    note: input.note,
    expiresAt: input.expiresAt,
    networkId: input.networkId,
  }
}
