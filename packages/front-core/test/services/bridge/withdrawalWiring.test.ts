import { describe, it, expect } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { resolveWithdrawalWiring } from "src/core/services/bridge/withdrawalWiring"

// Distinct addresses so the l2Token-vs-portal mapping is falsifiable.
const PORTAL = "0x1111111111111111111111111111111111111111"
const TOKEN = "0x2222222222222222222222222222222222222222"
const L2_TOKEN = "0x3333333333333333333333333333333333333333333333333333333333333333"
const EXECUTOR = "0x4444444444444444444444444444444444444444"
const WITHDRAWAL_SUBSIDY = "0x6666666666666666666666666666666666666666"

function makeTuple(overrides: Partial<OxideEnvTuple> = {}): OxideEnvTuple {
  return {
    version: "v4",
    gitSha: "deadbeef",
    timestamp: "2026-07-05T00:00:00.000Z",
    deployedAt: "2026-07-05T00:00:00.000Z",
    portal: PORTAL,
    token: TOKEN,
    l2Token: L2_TOKEN,
    enclaveUrl: "https://enclave.example/rpc",
    pcr0: "00",
    rollupVersion: "3",
    plainWithdrawalExecutor: EXECUTOR,
    depositSubsidy: "0x5555555555555555555555555555555555555555",
    withdrawalSubsidy: WITHDRAWAL_SUBSIDY,
    ...overrides,
  }
}

describe("resolveWithdrawalWiring", () => {
  it("maps a complete tuple to the reader inputs", () => {
    expect(resolveWithdrawalWiring(makeTuple())).toEqual({
      portal: PORTAL,
      l2Token: L2_TOKEN,
      plainWithdrawalExecutor: EXECUTOR,
    })
  })

  it("binds l2Token to the L2 oxide-token, NOT the L1 portal", () => {
    // A wrong l2Token finds no message hash for the burn, hanging every withdrawal silently.
    const wiring = resolveWithdrawalWiring(makeTuple())
    expect(wiring!.l2Token).toBe(L2_TOKEN)
    expect(wiring!.l2Token).not.toBe(PORTAL)
  })

  it("returns null when the portal is absent (sandbox / unresolved manifest)", () => {
    expect(resolveWithdrawalWiring(makeTuple({ portal: "" }))).toBeNull()
  })

  it("returns null when the plain withdrawal executor is absent", () => {
    expect(resolveWithdrawalWiring(makeTuple({ plainWithdrawalExecutor: undefined }))).toBeNull()
  })

  it("returns null when the l2Token is absent", () => {
    expect(resolveWithdrawalWiring(makeTuple({ l2Token: "" }))).toBeNull()
  })
})
