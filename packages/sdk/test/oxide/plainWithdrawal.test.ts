import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { EthAddress } from "@aztec/foundation/eth-address"
import { OxidePortalAbi } from "@oxide/l1-contracts"
import type { PublicClient } from "viem"

import type { Operation } from "../../src/oxide/l2_operations.js"
import { declaredWithdrawals, readPortalWithdrawalState } from "../../src/oxide/plainWithdrawal.js"

const withdraw = (amount: bigint) => ({
  kind: "withdraw" as const,
  from: AztecAddress.fromBigIntUnsafe(1n),
  executor: EthAddress.fromNumber(2),
  userPayload: Buffer.alloc(64, Number(amount)),
  amount,
  proverTip: 0n,
})

describe("declaredWithdrawals", () => {
  it("collects direct withdrawals and the ones outer calls declare, in batch order", () => {
    const [a, b, c] = [withdraw(1n), withdraw(2n), withdraw(3n)]
    const operations = [
      { kind: "transfer", from: a.from, to: a.from, amount: 1n },
      a,
      { kind: "outerCall", interaction: {} as never, withdrawals: [b, c] },
      { kind: "outerCall", interaction: {} as never },
    ] as Operation[]

    expect(declaredWithdrawals(operations)).toEqual([a, b, c])
  })
})

describe("readPortalWithdrawalState", () => {
  it("reads the portal's funding cut and frozen flag", async () => {
    const portal = `0x${"11".repeat(20)}` as const
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === "FPC_FUNDING_CUT" ? 42n : true,
    )

    const state = await readPortalWithdrawalState(
      { readContract } as unknown as PublicClient,
      portal,
    )

    expect(state).toEqual({ fpcFundingCut: 42n, frozen: true })
    expect(readContract.mock.calls.map(([call]) => call)).toEqual([
      { address: portal, abi: OxidePortalAbi, functionName: "FPC_FUNDING_CUT" },
      { address: portal, abi: OxidePortalAbi, functionName: "$frozen" },
    ])
  })
})
