import { describe, it, expect } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { resolveWithdrawalWiring } from "src/core/services/bridge/withdrawalWiring"

// Distinct addresses so the l2Portal-vs-portal mapping is actually falsifiable:
// if the resolver ever mapped l2Portal from tuple.portal, the assertions below
// would fail instead of coincidentally passing.
const PORTAL = "0x1111111111111111111111111111111111111111"
const TOKEN = "0x2222222222222222222222222222222222222222"
const L2_TOKEN = "0x3333333333333333333333333333333333333333333333333333333333333333"
const EXECUTOR = "0x4444444444444444444444444444444444444444"
const WITHDRAWAL_SUBSIDY = "0x6666666666666666666666666666666666666666"
const L1_CHAIN_ID = 11155111n

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
  it("maps a complete tuple to reader inputs + portal context", () => {
    const wiring = resolveWithdrawalWiring(makeTuple(), L1_CHAIN_ID)
    expect(wiring).not.toBeNull()
    expect(wiring!.portal).toBe(PORTAL)
    expect(wiring!.plainWithdrawalExecutor).toBe(EXECUTOR)
    // The withdrawal-flow subsidy, distinct from the deposit-flow `depositSubsidy`.
    expect(wiring!.withdrawalSubsidy).toBe(WITHDRAWAL_SUBSIDY)
    expect(wiring!.portalContext).toEqual({
      l1Portal: PORTAL,
      l2Portal: L2_TOKEN,
      rollupVersion: 3n,
      l1ChainId: L1_CHAIN_ID,
    })
  })

  it("binds l2Portal to the L2 oxide-token, NOT the L1 portal", () => {
    // The load-bearing invariant: a wrong l2Portal yields a withdrawalId that
    // $isWithdrawalSpent never flips, hanging every withdrawal silently.
    const wiring = resolveWithdrawalWiring(makeTuple(), L1_CHAIN_ID)
    expect(wiring!.portalContext.l2Portal).toBe(L2_TOKEN)
    expect(wiring!.portalContext.l2Portal).not.toBe(PORTAL)
  })

  it("coerces rollupVersion + chainId to bigint", () => {
    const wiring = resolveWithdrawalWiring(makeTuple({ rollupVersion: "42" }), 1n)
    expect(wiring!.portalContext.rollupVersion).toBe(42n)
    expect(wiring!.portalContext.l1ChainId).toBe(1n)
  })

  it("returns null when the portal is absent (sandbox / unresolved manifest)", () => {
    expect(resolveWithdrawalWiring(makeTuple({ portal: "" }), L1_CHAIN_ID)).toBeNull()
  })

  it("returns null when the plain withdrawal executor is absent", () => {
    expect(
      resolveWithdrawalWiring(makeTuple({ plainWithdrawalExecutor: undefined }), L1_CHAIN_ID),
    ).toBeNull()
  })

  it("still wires tracking when the withdrawal subsidy is absent, only dropping that field", () => {
    // Only self-finalize needs it.
    const wiring = resolveWithdrawalWiring(makeTuple({ withdrawalSubsidy: undefined }), L1_CHAIN_ID)
    expect(wiring).not.toBeNull()
    expect(wiring!.withdrawalSubsidy).toBeUndefined()
  })

  it("returns null when the l2Token is absent", () => {
    expect(resolveWithdrawalWiring(makeTuple({ l2Token: "" }), L1_CHAIN_ID)).toBeNull()
  })

  it("returns null when rollupVersion is non-numeric", () => {
    expect(resolveWithdrawalWiring(makeTuple({ rollupVersion: "latest" }), L1_CHAIN_ID)).toBeNull()
  })

  it("returns null when rollupVersion is empty", () => {
    expect(resolveWithdrawalWiring(makeTuple({ rollupVersion: "" }), L1_CHAIN_ID)).toBeNull()
  })
})
