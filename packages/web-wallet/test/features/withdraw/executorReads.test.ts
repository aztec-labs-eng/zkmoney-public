// @vitest-environment node
/** The page's executor and escrow-factory reads: immutables, read once per address. */
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

  it("reads a Sky escrow factory's two portals once", async () => {
    const FACTORY = `0x${"fa".repeat(20)}` as Address
    const portals = { DAI_PORTAL: `0x${"d1".repeat(20)}`, SUSDS_PORTAL: `0x${"d2".repeat(20)}` }
    const readContract = vi.fn(
      async ({ functionName }: { functionName: keyof typeof portals }) => portals[functionName],
    )
    const { skyFactoryPortalsAt } = readsOver(readContract)
    const expected = { daiPortal: portals.DAI_PORTAL, sUsdsPortal: portals.SUSDS_PORTAL }
    expect(await skyFactoryPortalsAt(FACTORY).read()).toEqual(expected)
    const upper = FACTORY.toUpperCase().replace("0X", "0x") as Address
    expect(await skyFactoryPortalsAt(upper).read()).toEqual(expected)
    expect(readContract).toHaveBeenCalledTimes(2)
  })
})
