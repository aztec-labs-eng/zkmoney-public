import { describe, expect, it } from "vitest"
import type { AcrossBridge } from "@obsidion/config-client"
import type { NotificationEntry, WithdrawalRecord } from "@obsidion/front-core"
import { notificationText } from "../../src/ui/notificationText"

const bridge: AcrossBridge = {
  apiUrl: "https://across.example",
  oxide: {},
  chains: [
    {
      chainId: 8453,
      name: "Base",
      etaMinutes: 7,
      rpcUrl: "https://base.example",
      in: [],
      out: [],
    },
  ],
}

const record = (phase: WithdrawalRecord["phase"], filledAmount?: string) =>
  ({
    localId: "w1",
    phase,
    amount: "25",
    startTime: 0,
    swapOutput: "USDC",
    swapOutputDecimals: 6,
    bridgeOut: {
      chainId: 8453,
      chainName: "Base",
      minReceived: "24900000",
      acrossFee: "1",
      nonce: "0x01",
      filledAmount,
    },
  } as unknown as WithdrawalRecord)

const arrived = (r: WithdrawalRecord) =>
  text({
    kind: "bridgeEnded",
    item: { kind: "bridge.withdrawal", record: r },
    outcome: "done",
    migration: false,
  }).description

const text = (about: NotificationEntry["about"]) => notificationText({ about }, bridge)

describe("bridge-out notifications", () => {
  it("names the destination chain while live, and the chain and amount once it arrives", () => {
    const live = text({
      kind: "bridgeLive",
      item: { kind: "bridge.withdrawal", record: record("bridging") },
      migration: false,
    })
    expect(live.title).toContain("Base")

    const done = arrived(record("done"))
    expect(done).toContain("Base")
    expect(done).toContain("24.9")
    expect(done).toContain("USDC")
  })

  it("names what the fill paid once it is read, not the burn", () => {
    const done = arrived(record("done", "25100000"))
    expect(done).toContain("25.1")
    expect(done).toContain("USDC")
    expect(done).not.toContain("$25")
  })

  it("names the burn when the record lacks the output's decimals", () => {
    const done = arrived({ ...record("done"), swapOutputDecimals: undefined })
    expect(done).toContain("$25")
  })

  it.each(["l2_mined", "awaiting_proven", "finalizing_l1"] as const)(
    "names the destination chain while %s releases it",
    (phase) => {
      const live = text({
        kind: "bridgeLive",
        item: { kind: "bridge.withdrawal", record: record(phase) },
        migration: false,
      })
      expect(live.description).toContain("Base")
    },
  )
})

describe("bridge-in notifications", () => {
  it("names what stayed in the wallet and the origin chain the profile lists for it", () => {
    const failed = text({
      kind: "bridgeInEnded",
      record: {
        id: "bridge-in:1",
        originTxHash: `0x${"ab".repeat(32)}`,
        originChainId: 8453,
        depositor: `0x${"a1".repeat(20)}`,
        recipient: `0x${"f0".repeat(20)}`,
        symbol: "USDC",
        inputAmount: "20500000",
        outputAmount: "20000000000000000000",
        fee: "500000",
        inputDecimals: 6,
        outputSymbol: "DAI",
        outputDecimals: 18,
        status: "failed",
        startTime: 0,
        endTime: 1,
      },
    })
    expect(failed.description).toContain("20.50 USDC") // debt-check-ignore: a figure, not copy
    expect(failed.description).toContain("Base")
  })

  it("names the token the bridge carried when the refund is not the coin sent", () => {
    const refunded = text({
      kind: "bridgeInEnded",
      record: {
        id: "bridge-in:2",
        originTxHash: `0x${"cd".repeat(32)}`,
        originChainId: 8453,
        depositor: `0x${"a1".repeat(20)}`,
        recipient: `0x${"f0".repeat(20)}`,
        symbol: "ETH",
        inputAmount: "500000000000000000",
        outputAmount: "1500000000",
        fee: "0",
        inputDecimals: 18,
        outputSymbol: "USDC",
        outputDecimals: 6,
        bridged: { symbol: "WETH", amount: "500000000000000000", decimals: 18 },
        status: "refunded",
        startTime: 0,
        endTime: 1,
      },
    })
    expect(refunded.description).toContain("ETH")
    expect(refunded.description).toContain("WETH")
  })
})
