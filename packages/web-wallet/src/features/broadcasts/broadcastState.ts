import { TxHash } from "@aztec/stdlib/tx"
import { isFailedSubmission, type BroadcastTxState } from "@obsidion/front-core"
import type { ObsidionWallet } from "@obsidion/sdk"

/** Where a sent broadcast stands. An unreachable node reads as `pending`: nothing is repeated on a guess. */
export async function broadcastState(
  wallet: Pick<ObsidionWallet, "node">,
  txHash: string,
): Promise<BroadcastTxState> {
  try {
    const receipt = await wallet.node.getTxReceipt(TxHash.fromString(txHash))
    if (isFailedSubmission(receipt)) return "dropped"
    return receipt.blockNumber !== undefined ? "included" : "pending"
  } catch {
    return "pending"
  }
}
