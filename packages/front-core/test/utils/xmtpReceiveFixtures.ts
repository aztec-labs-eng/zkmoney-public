import type { TokenTransaction } from "../../src/types/transactions"
import type { NewIncomingTokenTx } from "../../src/xmtp/receiverTypes"

export function fakeIncomingTokenTx(input: NewIncomingTokenTx): TokenTransaction {
  return {
    id: input.txHash.toLowerCase(),
    txHash: input.txHash,
    amountAtomic: input.amountAtomic,
    timestamp: input.timestamp,
    status: "success",
    action: input.action ?? "receive",
    token: input.token,
    from: input.from,
    senderL2Address: input.senderL2Address,
    to: input.to,
    memo: input.memo,
  } as unknown as TokenTransaction
}
