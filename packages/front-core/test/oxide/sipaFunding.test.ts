import { describe, expect, it } from "vitest"
import type { Address, PublicClient } from "viem"
import { readSipaFunding, type SipaFundingToken } from "../../src/oxide/sipaFunding"

const DAI: SipaFundingToken = { address: "0x1", symbol: "DAI", decimals: 18 }
const USDC: SipaFundingToken = { address: "0x2", symbol: "USDC", decimals: 6 }
const USDT: SipaFundingToken = { address: "0x3", symbol: "USDT", decimals: 6 }

/** `balanceOf` per token; a rejected read models an RPC failure on that token alone. */
function client(balances: Record<Address, bigint | Error>): PublicClient {
  return {
    readContract: async ({ address }: { address: Address }) => {
      const balance = balances[address]
      if (balance instanceof Error) throw balance
      return balance
    },
  } as never
}

const params = (publicClient: PublicClient) =>
  readSipaFunding(publicClient, {
    sipa: "0xdead",
    feeToken: DAI,
    fundingTokens: [DAI, USDC, USDT],
    fee: 10n ** 18n,
    fpcFundingCut: 0n,
  })

describe("readSipaFunding", () => {
  it("still finds the sweepable token past a failed read of an unrelated one", async () => {
    const funding = await params(
      client({
        [DAI.address]: 0n,
        [USDC.address]: new Error("rpc down"),
        [USDT.address]: 5_000_000n,
      }),
    )
    expect(funding.token).toBe(USDT)
    expect(funding.status.sweepable).toBe(true)
  })

  it("rethrows the failure when no token answers the sweep", async () => {
    await expect(
      params(
        client({ [DAI.address]: 0n, [USDC.address]: new Error("rpc down"), [USDT.address]: 0n }),
      ),
    ).rejects.toThrow("rpc down")
  })
})
