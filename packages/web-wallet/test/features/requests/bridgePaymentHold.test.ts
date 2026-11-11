import { describe, expect, it } from "vitest"
import type { BridgeInRecord } from "@obsidion/front-core"
import { bridgePaymentHold } from "../../../src/features/requests/bridgePaymentHold"

const PAYEE = "0x00000000000000000000000000000000000000aA"
const OTHER = "0x00000000000000000000000000000000000000bB"

const record = (id: string, over: Partial<BridgeInRecord> = {}): BridgeInRecord => ({
  id,
  originChainId: 8453,
  depositor: `0x${"a1".repeat(20)}`,
  recipient: PAYEE,
  symbol: "USDC",
  inputAmount: "20500000",
  outputAmount: "20000000000000000000",
  fee: "500000",
  inputDecimals: 6,
  outputSymbol: "DAI",
  outputDecimals: 18,
  status: "signing",
  startTime: 0,
  pays: { payee: "bob", requestId: "r" },
  ...over,
})

describe("a bridge payment's hold on the pay sheet", () => {
  it.each([
    ["signing before the hash comes back", record("a"), "a"],
    ["pending", record("a", { status: "pending" }), "a"],
    ["filled", record("a", { status: "filled" }), "a"],
    ["dropped at the prompt", record("a", { status: "failed" }), undefined],
    ["refunded", record("a", { status: "refunded" }), undefined],
    ["expired", record("a", { status: "expired" }), undefined],
    ["to another address", record("a", { recipient: OTHER }), undefined],
    ["into this wallet's own deposit", record("a", { pays: undefined }), undefined],
  ] as const)("a bridge-in %s", (_, saved, held) => {
    expect(bridgePaymentHold([saved], PAYEE.toLowerCase())).toBe(held)
  })

  it("names the newest payment, so paying again over it leaves a later one held", () => {
    expect(bridgePaymentHold([record("new"), record("old", { status: "filled" })], PAYEE)).toBe(
      "new",
    )
  })
})
