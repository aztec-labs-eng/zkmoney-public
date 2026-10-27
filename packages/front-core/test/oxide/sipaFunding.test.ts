import { describe, expect, it } from "vitest"
import type { Address, PublicClient } from "viem"
import { inRowUnits, readSipaFunding, type SipaFundingToken } from "../../src/oxide/sipaFunding"

const DAI: SipaFundingToken = { address: "0x1", symbol: "DAI", decimals: 18 }
const USDC: SipaFundingToken = { address: "0x2", symbol: "USDC", decimals: 6 }
const USDT: SipaFundingToken = { address: "0x3", symbol: "USDT", decimals: 6 }
const SUSDS: SipaFundingToken = { address: "0x4", symbol: "sUSDS", decimals: 18 }

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

const DAI_FEE = 10n ** 18n
const DAI_CAP = 10_000n * 10n ** 18n

/** The mainnet DAI row: DAI, and USDC and USDT, which the SIPA swaps into DAI. */
const daiRow = [DAI, USDC, USDT].map((token) => ({
  token,
  settlesIn: DAI,
  fee: DAI_FEE,
  txAmountCap: DAI_CAP,
}))

const params = (publicClient: PublicClient) =>
  readSipaFunding(publicClient, { sipa: "0xdead", routes: daiRow })

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

describe("readSipaFunding across rows", () => {
  it("prices each token on its own row's fee and cap", async () => {
    // sUSDS clears its own row's fee, which is larger than DAI's.
    const routes = [
      { token: DAI, fee: 10n ** 16n, txAmountCap: DAI_CAP },
      { token: SUSDS, fee: 2n * 10n ** 18n, txAmountCap: 5n * 10n ** 18n },
    ]
    const under = await readSipaFunding(
      client({ [DAI.address]: 0n, [SUSDS.address]: 10n ** 18n }),
      {
        sipa: "0xdead",
        routes,
      },
    )
    expect(under.token).toBe(SUSDS)
    expect(under.status).toMatchObject({ sweepable: false, fee: 2n * 10n ** 18n })

    const inside = await readSipaFunding(
      client({ [DAI.address]: 0n, [SUSDS.address]: 6n * 10n ** 18n }),
      { sipa: "0xdead", routes },
    )
    expect(inside.status).toMatchObject({ sweepable: true, fee: 2n * 10n ** 18n })

    // Past the sUSDS portal's cap, though well inside DAI's.
    const over = await readSipaFunding(
      client({ [DAI.address]: 0n, [SUSDS.address]: 8n * 10n ** 18n }),
      { sipa: "0xdead", routes },
    )
    expect(over.status.sweepable).toBe(false)
  })

  it("prices a row whose token has fewer decimals than the fee token in its own units", async () => {
    // A USDC row of its own, beside the 18-decimal fee token's: its fee and cap are in USDC units.
    const routes = [
      { token: DAI, fee: DAI_FEE, txAmountCap: DAI_CAP },
      { token: USDC, fee: 500_000n, txAmountCap: 1_000n * 10n ** 6n },
    ]
    const funding = await readSipaFunding(
      client({ [DAI.address]: 0n, [USDC.address]: 2_000_000n }),
      {
        sipa: "0xdead",
        routes,
      },
    )
    expect(funding.token).toBe(USDC)
    expect(funding.status).toEqual({
      balance: 2_000_000n,
      scaledBalance: 2_000_000n,
      fee: 500_000n,
      sweepable: true,
    })

    const dust = await readSipaFunding(client({ [DAI.address]: 0n, [USDC.address]: 400_000n }), {
      sipa: "0xdead",
      routes,
    })
    expect(dust.status.sweepable).toBe(false)
  })

  it("ranks unsweepable balances across rows by value, not raw units", async () => {
    const funding = await readSipaFunding(
      client({ [DAI.address]: 10n ** 12n, [USDC.address]: 300_000n }),
      {
        sipa: "0xdead",
        routes: [
          { token: DAI, fee: DAI_FEE, txAmountCap: DAI_CAP },
          { token: USDC, fee: 500_000n, txAmountCap: 10n ** 9n },
        ],
      },
    )
    // 0.3 USDC outweighs 0.000001 DAI, though its raw balance is smaller.
    expect(funding.token).toBe(USDC)
  })

  it("measures a swapped token in the units of the row it swaps into", async () => {
    const funding = await params(
      client({ [DAI.address]: 0n, [USDC.address]: 0n, [USDT.address]: 5_000_000n }),
    )
    expect(funding.status).toMatchObject({ balance: 5_000_000n, scaledBalance: 5n * 10n ** 18n })
  })
})

describe("inRowUnits", () => {
  it("rescales a swapped amount both ways", () => {
    expect(inRowUnits(1_000_000n, USDC, DAI)).toBe(10n ** 18n)
    expect(inRowUnits(10n ** 18n, DAI, USDC)).toBe(1_000_000n)
    expect(inRowUnits(7n, DAI, DAI)).toBe(7n)
  })
})
