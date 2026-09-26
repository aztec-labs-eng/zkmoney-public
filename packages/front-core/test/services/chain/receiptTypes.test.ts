import { describe, expect, it } from "vitest"
import { TxExecutionResult, TxStatus } from "@aztec/stdlib/tx"
import {
  hasBlockMoved,
  isRevertedInclusion,
  type ReorgTxReceiptLike,
} from "../../../src/core/services/chain/receiptTypes"

const receipt = (over: Partial<ReorgTxReceiptLike>): ReorgTxReceiptLike => ({
  status: TxStatus.PROPOSED,
  ...over,
})

describe("isRevertedInclusion", () => {
  it("is true for a reverted tx at any included or finalized tier", () => {
    for (const status of [
      TxStatus.PROPOSED,
      TxStatus.CHECKPOINTED,
      TxStatus.PROVEN,
      TxStatus.FINALIZED,
    ]) {
      expect(isRevertedInclusion(receipt({ status, executionResult: TxExecutionResult.REVERTED }))).toBe(
        true,
      )
    }
  })

  it("is false when the tx is not in a block, even if reverted", () => {
    for (const status of [TxStatus.PENDING, TxStatus.DROPPED]) {
      expect(isRevertedInclusion(receipt({ status, executionResult: TxExecutionResult.REVERTED }))).toBe(
        false,
      )
    }
  })

  it("is false when execution succeeded or the adapter omits the field", () => {
    expect(
      isRevertedInclusion(receipt({ status: TxStatus.PROPOSED, executionResult: TxExecutionResult.SUCCESS })),
    ).toBe(false)
    expect(isRevertedInclusion(receipt({ status: TxStatus.FINALIZED }))).toBe(false)
  })

  it("is false for an unknown status value", () => {
    expect(
      isRevertedInclusion(
        receipt({ status: "future-tier" as TxStatus, executionResult: TxExecutionResult.REVERTED }),
      ),
    ).toBe(false)
  })
})

describe("hasBlockMoved", () => {
  it("is true when both block numbers are defined and differ", () => {
    expect(hasBlockMoved({ blockNumber: 42 }, { blockNumber: 43 })).toBe(true)
    expect(hasBlockMoved({ blockNumber: 43 }, { blockNumber: 42 })).toBe(true) // symmetric
  })

  it("is true on a same-height re-inclusion — same number, different hash", () => {
    expect(
      hasBlockMoved(
        { blockNumber: 42, blockHash: "0xold" },
        { blockNumber: 42, blockHash: "0xnew" },
      ),
    ).toBe(true)
  })

  it("is false when number and hash both match", () => {
    expect(
      hasBlockMoved(
        { blockNumber: 42, blockHash: "0xsame" },
        { blockNumber: 42, blockHash: "0xsame" },
      ),
    ).toBe(false)
    expect(hasBlockMoved({ blockNumber: 42 }, { blockNumber: 42 })).toBe(false)
  })

  it("never compares an undefined side", () => {
    expect(hasBlockMoved({}, { blockNumber: 43, blockHash: "0xh" })).toBe(false)
    expect(hasBlockMoved({ blockNumber: 42, blockHash: "0xh" }, {})).toBe(false)
    expect(hasBlockMoved({ blockNumber: 42 }, { blockNumber: 42, blockHash: "0xh" })).toBe(false)
  })
})
