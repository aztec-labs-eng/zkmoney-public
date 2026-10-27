import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import type { PaymentRequest } from "../core/storages/RequestStorage.js"
import type { IncomingRequestInput } from "./requestReceiverTypes.js"

/** The receiver-side XMTP request packet mapped to a stored PaymentRequest row. */
export function incomingRequestToRow(input: IncomingRequestInput): PaymentRequest {
  const amount = Number(input.amountAtomic) / 10 ** input.decimals
  return {
    id: input.requestId,
    contactTag: input.requesterTag,
    amount: Number.isFinite(amount) ? amount : 0,
    asset: input.tokenSymbol ?? WALLET_TOKEN_SYMBOL,
    direction: "incoming",
    status: "pending",
    createdAt: Date.now(),
    kind: "contact",
    tokenAddress: input.tokenAddress,
    amountAtomic: input.amountAtomic,
    tokenDecimals: input.decimals,
    note: input.note,
    expiresAt: input.expiresAt,
    networkId: input.networkId,
  }
}
