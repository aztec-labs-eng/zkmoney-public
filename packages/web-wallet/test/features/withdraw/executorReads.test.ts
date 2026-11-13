// @vitest-environment node
/** The page's executor reads: immutables, read once per address. */
import { describe, expect, it, vi } from "vitest"
import type { Address, PublicClient } from "viem"
import { withdrawalReads } from "../../../src/features/withdraw/executorReads"
import { testQuery } from "../../support/query"

const readsOver = (readContract: ReturnType<typeof vi.fn>) =>
  withdrawalReads(() => ({ readContract } as unknown as PublicClient), testQuery())

describe("withdrawalReads", () => {
  it("reads an executor's subsidy once, and again after a failed read", async () => {
    const EXECUTOR = `0x${"44".repeat(20)}` as Address
    const SUBSIDY = `0x${"55".repeat(20)}` as Address
    const down = new Error("rpc down")
    const readContract = vi.fn()
    readContract.mockRejectedValueOnce(down).mockResolvedValue(SUBSIDY)
    const { executorSubsidyAt } = readsOver(readContract)
    await expect(executorSubsidyAt(EXECUTOR).read()).rejects.toBe(down)
    expect(await executorSubsidyAt(EXECUTOR).read()).toBe(SUBSIDY)
    expect(await executorSubsidyAt(EXECUTOR.toLowerCase() as Address).read()).toBe(SUBSIDY)
    expect(readContract).toHaveBeenCalledTimes(2)
  })
})
