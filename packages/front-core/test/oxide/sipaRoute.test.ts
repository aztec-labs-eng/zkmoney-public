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
    expect(sipaIntentName(SipaIntent.UserOp)).toBe("user-op")
    expect(() => sipaIntentName(SipaIntent.None)).toThrow(/no forwarding-table row/)
  })

  it("maps a record's intent to the factory intent its address commits to", () => {
    expect(sipaRecordIntent(undefined)).toBe(SipaIntent.Deposit)
    expect(sipaRecordIntent("registration")).toBe(SipaIntent.Registration)
    expect(sipaRecordIntent("user-op")).toBe(SipaIntent.UserOp)
  })

  it("records a factory intent only when the wallet pays it", () => {
    expect(sipaRecordIntentOf(SipaIntent.Deposit)).toBeUndefined()
    expect(sipaRecordIntentOf(SipaIntent.Registration)).toBe("registration")
    expect(sipaRecordIntentOf(SipaIntent.UserOp)).toBe("user-op")
    expect(sipaRecordIntentOf(SipaIntent.UpdateMetadata)).toBeNull()
    expect(sipaRecordIntentOf(SipaIntent.None)).toBeNull()
  })

  it("settles a user operation on the fee token's row, whatever token funds it", () => {
    expect(deploymentSipaRoute(TUPLE, SipaIntent.UserOp, SUSDS)).toEqual({
      forwardingTable: FORWARDING_TABLE,
      token: DAI,
      intent: SipaIntent.UserOp,
    })
    expect(deploymentSipaRoute(TUPLE, SipaIntent.Deposit, SUSDS).token).toBe(SUSDS)
  })

  it("routes a recorded user operation through its table's UserOp row, apart from a deposit's", () => {
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
    const userOp = sipaRecordRoute({ origin, intent: "user-op" })
    const deposit = sipaRecordRoute({ origin, intent: undefined })

    expect(userOp).toEqual({ forwardingTable: FORWARDING_TABLE, intent: SipaIntent.UserOp })
    expect(sipaRouteKey(userOp!)).not.toBe(sipaRouteKey(deposit!))
  })
})
