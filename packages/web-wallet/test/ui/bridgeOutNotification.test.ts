import { describe, expect, it } from "vitest"
import type { ConfigBridge } from "@obsidion/config-client"
import type { NotificationEntry, WithdrawalRecord } from "@obsidion/front-core"
import { notificationText } from "../../src/ui/notificationText"

const bridge: ConfigBridge = {
  provider: "across",
  apiUrl: "https://across.example",
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

const record = (phase: WithdrawalRecord["phase"]) =>
  ({
    localId: "w1",
    phase,
    amount: "25",
    startTime: 0,
    bridgeOut: {
      chainId: 8453,
      chainName: "Base",
      minReceived: "24900000",
      acrossFee: "1",
      nonce: "0x01",
    },
  } as unknown as WithdrawalRecord)

const text = (about: NotificationEntry["about"]) => notificationText({ about }, bridge)

describe("bridge-out notifications", () => {
  it("names the destination chain while live, and the chain and amount once it arrives", () => {
    const live = text({
      kind: "bridgeLive",
      item: { kind: "bridge.withdrawal", record: record("bridging") },
      migration: false,
    })
    expect(live.title).toContain("Base")

    const done = text({
      kind: "bridgeEnded",
      item: { kind: "bridge.withdrawal", record: record("done") },
      outcome: "done",
      migration: false,
    })
    expect(done.description).toContain("Base")
    expect(done.description).toContain("$25")
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
})
