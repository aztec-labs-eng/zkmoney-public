import { describe, expect, it } from "vitest"
import type { Address, Hash } from "viem"
import { sipaCredits } from "../../../src/core/services/deposits/sipaCredits"
import type { SIPADepositRecord } from "../../../src/core/services/deposits/SIPADepositStore"

const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f" as Address
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address
const SUSDS = "0x5875eee11cf8398102fdad704c9e96607675467a" as Address

const daiSweep = {
  inboxIndex: "7",
  sweepTxHash: "0xsweep7" as Hash,
  netAmount: "990000000000000000",
  tokenAddress: DAI,
  tokenSymbol: "DAI",
  tokenDecimals: 18,
}

function record(over: Partial<SIPADepositRecord>): SIPADepositRecord {
  return {
    sipaAddress: "0x00000000000000000000000000000000000000bb" as Address,
    recipientL2Address: "0x01",
    messageSecret: "0x02",
    recipientHash: "0x03",
    recoveryAddress: "",
    l1ChainId: 1,
    amount: "5",
    tokenSymbol: "USDC",
    phase: "sweeping",
    startTime: 1,
    sweeps: [daiSweep],
    ...over,
  }
}

describe("sipaCredits", () => {
  it("keeps a claimed DAI sweep with a new payment that swaps into DAI", () => {
    const credits = sipaCredits(record({ tokenAddress: USDC, rowToken: DAI }))
    expect(credits).toHaveLength(1)
  })

  it("splits out a sweep of another row's token", () => {
    const credits = sipaCredits(record({ tokenAddress: SUSDS, tokenSymbol: "sUSDS" }))
    expect(credits.map((c) => c.token)).toEqual([undefined, DAI])
    expect(credits[1]!.record).toMatchObject({
      phase: "claimed",
      tokenSymbol: "DAI",
      amount: "0.99",
    })
  })
})
