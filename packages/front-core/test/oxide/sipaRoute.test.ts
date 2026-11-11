import { describe, expect, it } from "vitest"
import { SipaIntent } from "@oxide/l1-contracts"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address, Hex } from "viem"
import {
  deploymentSipaRoute,
  sipaIntentName,
  sipaRecordIntent,
  sipaRecordIntentOf,
  sipaRecordRoute,
  sipaRouteKey,
} from "../../src/oxide/sipaRoute"

const FORWARDING_TABLE = `0x${"fb".repeat(20)}` as Address
const DAI = `0x${"d1".repeat(20)}`
const SUSDS = `0x${"5d".repeat(20)}`
const TUPLE = {
  forwardingTable: FORWARDING_TABLE,
  token: SUSDS,
  underlying: SUSDS,
  feeToken: DAI,
} as unknown as OxideEnvTuple

describe("sipaRoute", () => {
  it("names every factory intent a row prices", () => {
    expect(sipaIntentName(SipaIntent.Deposit)).toBe("deposit")
    expect(sipaIntentName(SipaIntent.Registration)).toBe("registration")
    expect(sipaIntentName(SipaIntent.AddPasskey)).toBe("add-passkey")
    expect(() => sipaIntentName(SipaIntent.None)).toThrow(/no forwarding-table row/)
  })

  it("maps a record's intent to the factory intent its address commits to", () => {
    expect(sipaRecordIntent(undefined)).toBe(SipaIntent.Deposit)
    expect(sipaRecordIntent("registration")).toBe(SipaIntent.Registration)
    expect(sipaRecordIntent("add-passkey")).toBe(SipaIntent.AddPasskey)
  })

  it("records a factory intent only when the wallet pays it", () => {
    expect(sipaRecordIntentOf(SipaIntent.Deposit)).toBeUndefined()
    expect(sipaRecordIntentOf(SipaIntent.Registration)).toBe("registration")
    expect(sipaRecordIntentOf(SipaIntent.AddPasskey)).toBe("add-passkey")
    expect(sipaRecordIntentOf(3 as SipaIntent)).toBeNull()
    expect(sipaRecordIntentOf(SipaIntent.None)).toBeNull()
  })

  it("settles an add-passkey on the fee token's row, whatever token funds it", () => {
    expect(deploymentSipaRoute(TUPLE, SipaIntent.AddPasskey, SUSDS)).toEqual({
      forwardingTable: FORWARDING_TABLE,
      token: DAI,
      intent: SipaIntent.AddPasskey,
    })
    expect(deploymentSipaRoute(TUPLE, SipaIntent.Deposit, SUSDS).token).toBe(SUSDS)
  })

  it("routes a recorded add-passkey through its table's AddPasskey row, apart from a deposit's", () => {
    const origin = {
      protocol: "account" as const,
      forwardingTable: FORWARDING_TABLE,
      recoveryAccount: `0x${"aa".repeat(20)}` as Address,
      recoveryCommitment: `0x${"bb".repeat(32)}` as Hex,
      accountFactory: `0x${"cc".repeat(20)}` as Address,
      sipaFactory: `0x${"dd".repeat(20)}` as Address,
      implementation: `0x${"ee".repeat(20)}` as Address,
      intentHash: `0x${"ff".repeat(32)}` as Hex,
      rollupVersion: "1",
      resweepable: false,
    }
    const addPasskey = sipaRecordRoute({ origin, intent: "add-passkey" })
    const deposit = sipaRecordRoute({ origin, intent: undefined })

    expect(addPasskey).toEqual({ forwardingTable: FORWARDING_TABLE, intent: SipaIntent.AddPasskey })
    expect(sipaRouteKey(addPasskey!)).not.toBe(sipaRouteKey(deposit!))
  })
})
