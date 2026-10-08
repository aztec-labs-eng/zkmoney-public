import { describe, expect, it, vi } from "vitest"
import type { PublicClient } from "viem"

import { readSipaPortalTerms } from "../../src/oxide/sipaPortalTerms.js"

const implementation = `0x${"aa".repeat(20)}` as const
const portal = `0x${"11".repeat(20)}` as const
const token = `0x${"22".repeat(20)}` as const

function client(values: Record<string, unknown>) {
  const readContract = vi.fn(
    async ({ address, functionName }: { address: string; functionName: string }) => {
      const value = values[`${address.toLowerCase()}.${functionName}`]
      if (value === undefined) throw new Error(`unexpected read ${address}.${functionName}`)
      if (value instanceof Error) throw value
      return value
    },
  )
  return { client: { readContract } as unknown as PublicClient, readContract }
}

describe("readSipaPortalTerms", () => {
  it("reads the portal, token and fee off the implementation and the cut off that portal", async () => {
    const { client: c, readContract } = client({
      [`${implementation}.PORTAL`]: portal,
      [`${implementation}.DEPOSIT_FEE`]: 5n,
      [`${implementation}.UNDERLYING`]: token,
      [`${portal}.FPC_FUNDING_CUT`]: 2n,
    })

    await expect(readSipaPortalTerms(c, implementation)).resolves.toEqual({
      portal,
      token,
      depositFee: 5n,
      fpcFundingCut: 2n,
    })
    const cut = readContract.mock.calls.find(([call]) => call.functionName === "FPC_FUNDING_CUT")
    expect(cut?.[0].address).toBe(portal)
  })

  it("rejects when a read fails", async () => {
    const { client: c } = client({
      [`${implementation}.PORTAL`]: portal,
      [`${implementation}.DEPOSIT_FEE`]: 5n,
      [`${implementation}.UNDERLYING`]: new Error("rpc down"),
      [`${portal}.FPC_FUNDING_CUT`]: 2n,
    })
    await expect(readSipaPortalTerms(c, implementation)).rejects.toThrow("rpc down")
  })
})
