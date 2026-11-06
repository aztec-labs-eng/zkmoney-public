import { describe, expect, it } from "vitest"
import type {
  ReorgTxReceiptLike,
  ReorgNodeLike,
} from "../../../src/core/services/chain/receiptTypes"
import { TxStatus } from "@aztec-labs/stdlib/tx"

const TX_HASH = "0x" + "11".repeat(32)
const BLOCK_HASH = "0x" + "22".repeat(32)

describe("receipt shape", () => {
  it("ReorgTxReceiptLike / ReorgNodeLike are structural", async () => {
    const receipt: ReorgTxReceiptLike = {
      status: TxStatus.PROPOSED,
      blockNumber: 7,
      blockHash: BLOCK_HASH,
    }
    const node: ReorgNodeLike = { getTxReceipt: async () => receipt }
    await expect(node.getTxReceipt(TX_HASH)).resolves.toEqual(receipt)
  })
})
