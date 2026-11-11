import { describe, expect, it } from "vitest"
import type { Address, Hash } from "viem"
import {
  isFirstSipaPayment,
  sipaCredits,
  sipaPaymentIndex,
} from "../../../src/core/services/deposits/sipaCredits"
import type { SipaDeposit } from "../../../src/engine/sipaDeposits"

const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f" as Address
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address
const SUSDS = "0x5875eee11cf8398102fdad704c9e96607675467a" as Address

const daiSweep = (inboxIndex: string, netAmount: string, settledAt?: number) => ({
  inboxIndex,
  sweepTxHash: `0xsweep${inboxIndex}` as Hash,
  netAmount,
  tokenAddress: DAI,
  tokenSymbol: "DAI",
  tokenDecimals: 18,
  ...(settledAt === undefined ? {} : { settledAt }),
})

function record(over: Partial<SipaDeposit>): SipaDeposit {
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
    claimedInboxIndexes: ["7"],
    sweeps: [daiSweep("7", "990000000000000000")],
    ...over,
  }
}

describe("sipaCredits", () => {
  it("reads a once-paid address as the record itself", () => {
    const once = record({ phase: "claimed", inboxIndex: "7" })
    expect(sipaCredits(once)).toEqual([{ record: once }])
  })

  it("keeps a claimed DAI sweep as its own payment beside a new payment that swaps into DAI", () => {
    const paidAgain = record({ tokenAddress: USDC, rowToken: DAI, inboxIndex: "7" })
    const credits = sipaCredits(paidAgain)
    expect(credits.map((c) => c.payment)).toEqual(["7", undefined])
    expect(credits[0]!.record).toMatchObject({
      phase: "claimed",
      tokenSymbol: "DAI",
      amount: "0.99",
    })
    expect(credits[1]!.record).toBe(paidAgain)
  })

  it("splits out a sweep of another row's token", () => {
    const credits = sipaCredits(record({ tokenAddress: SUSDS, tokenSymbol: "sUSDS" }))
    expect(credits.map((c) => c.payment)).toEqual(["7", undefined])
    expect(credits[0]!.record).toMatchObject({
      phase: "claimed",
      tokenSymbol: "DAI",
      amount: "0.99",
    })
  })

  it("reads an address paid and claimed twice in one token as two payments, each dated by its sweep", () => {
    const twice = record({
      phase: "claimed",
      tokenAddress: DAI,
      tokenSymbol: "DAI",
      amount: "6.75",
      netAmount: "6750000000000000000",
      inboxIndex: "8",
      claimedInboxIndexes: ["7", "8"],
      startTime: 100,
      endTime: 900,
      sweeps: [
        daiSweep("7", "9750000000000000000", 200),
        daiSweep("8", "6750000000000000000", 800),
      ],
    })
    const credits = sipaCredits(twice)
    expect(credits.map((c) => [c.payment, c.record.amount, c.record.startTime])).toEqual([
      ["7", "9.75", 200],
      [undefined, "6.75", 800],
    ])
    expect(credits[0]!.record).toMatchObject({
      phase: "claimed",
      inboxIndex: "7",
      sweepTxHash: "0xsweep7",
      endTime: 200,
    })
  })

  it("leaves what the address's latest payment did off a past one", () => {
    const recovered = record({
      phase: "recovered",
      inboxIndex: "7",
      recoveryTxHash: "0xrecover" as Hash,
      failure: { code: "unknown" },
    })
    const [past] = sipaCredits(recovered)
    expect(past!.record).toMatchObject({ phase: "claimed" })
    expect(past!.record.recoveryTxHash).toBeUndefined()
    expect(past!.record.failure).toBeUndefined()
  })
})

describe("sipaPaymentIndex", () => {
  it("names the sweep the record describes, and none while a new payment awaits its sweep", () => {
    expect(sipaPaymentIndex(record({ phase: "claimed", inboxIndex: "7" }))).toBe("7")
    expect(sipaPaymentIndex(record({ inboxIndex: "7" }))).toBeUndefined()
    expect(sipaPaymentIndex(record({ phase: "pendingClaim", inboxIndex: "8" }))).toBe("8")
    expect(
      sipaPaymentIndex(record({ phase: "broadcast", sweeps: [], claimedInboxIndexes: [] })),
    ).toBe(undefined)
  })

  it("finds an address's first payment in a past sweep once the address is paid again", () => {
    const [past, own] = sipaCredits(record({ inboxIndex: "7" }))
    expect(isFirstSipaPayment(past!.record)).toBe(true)
    expect(isFirstSipaPayment(own!.record)).toBe(false)
    expect(isFirstSipaPayment(record({ phase: "claimed", inboxIndex: "7" }))).toBe(true)
  })
})
