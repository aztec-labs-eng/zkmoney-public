import { describe, it, expect, vi, afterEach } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { PaylinkService, type PaylinkParams } from "@obsidion/sdk"
import {
  refundParamsFromRow,
  isPaylinkInRefundWindow,
  paylinkWindows,
  eligibleEscrowRows,
} from "../../src/core/services/paylink/refundParamsFromRow"
import {
  markRefundInFlight,
  clearRefundInFlight,
} from "../../src/core/services/paylink/refundInFlight"
import type { PaylinkTransaction } from "../../src/types"

// `refundParamsFromRow` delegates the link decode to
// `PaylinkService.parsePaylinkUrl`; the codec itself is covered by the SDK's
// own round-trip tests. Here we stub the decode to focus on the helper's
// contract: gate on the row's material, pass decoded fields through, fail-soft
// to `null`. (The SDK's cbor-x byte serialization doesn't round-trip cleanly in
// this jsdom env, so a real link round-trip would test the wrong layer.)
const decodedParams = (overrides: Partial<PaylinkParams> = {}): PaylinkParams => ({
  secret: Fr.random(),
  paylinkType: "paylinkDirect",
  classId: Fr.random(),
  chainId: 31337,
  rollupVersion: 1,
  ...overrides,
})

const baseRow = (overrides: Partial<PaylinkTransaction>): PaylinkTransaction =>
  ({
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "direct",
    timestamp: Date.now(),
    status: "success",
    txHash: "0xrow",
    ...overrides,
  } as PaylinkTransaction)

afterEach(() => {
  vi.restoreAllMocks()
})

describe("refundParamsFromRow", () => {
  it("happy path: decodes the row's own link", async () => {
    const decoded = decodedParams()
    vi.spyOn(PaylinkService, "parsePaylinkUrl").mockResolvedValue(decoded)
    const row = baseRow({ paylink: "https://x/#frag", fallbackSecret: Fr.random().toString() })

    const params = await refundParamsFromRow(row)

    expect(PaylinkService.parsePaylinkUrl).toHaveBeenCalledWith("https://x/#frag")
    expect(params).toBe(decoded)
  })

  it("returns null when fallbackSecret is missing (unfinished create) without decoding", async () => {
    const spy = vi.spyOn(PaylinkService, "parsePaylinkUrl")
    const row = baseRow({ paylink: "https://x/#frag", fallbackSecret: undefined })
    expect(await refundParamsFromRow(row)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it("returns null when paylink is missing (scrubbed/cancelled row)", async () => {
    const row = baseRow({ paylink: undefined, fallbackSecret: Fr.random().toString() })
    expect(await refundParamsFromRow(row)).toBeNull()
  })

  it("returns null (no throw) when the link decode throws", async () => {
    vi.spyOn(PaylinkService, "parsePaylinkUrl").mockRejectedValue(new Error("Invalid paylink link"))
    const row = baseRow({ paylink: "https://x/#garbage", fallbackSecret: Fr.random().toString() })
    await expect(refundParamsFromRow(row)).resolves.toBeNull()
  })
})

describe("eligibleEscrowRows", () => {
  const escrowRow = (overrides: Partial<PaylinkTransaction> = {}): PaylinkTransaction =>
    baseRow({
      paylink: "https://x/#frag",
      fallbackSecret: Fr.random().toString(),
      payToEmailSecret: "0xsecret-escrow",
      ...overrides,
    })

  it("includes a row with decodable material and no lifecycle flags", async () => {
    vi.spyOn(PaylinkService, "parsePaylinkUrl").mockResolvedValue(decodedParams())
    const rows = await eligibleEscrowRows([escrowRow()])
    expect(rows).toHaveLength(1)
    expect(rows[0].txHash).toBe("0xrow")
  })

  it("excludes migrated and refund-in-flight rows", async () => {
    vi.spyOn(PaylinkService, "parsePaylinkUrl").mockResolvedValue(decodedParams())
    markRefundInFlight("0xinflight")
    try {
      const rows = await eligibleEscrowRows([
        escrowRow({ txHash: "0xc", isMigrated: true }),
        escrowRow({ txHash: "0xd", payToEmailSecret: "0xinflight" }),
      ])
      expect(rows).toEqual([])
    } finally {
      clearRefundInFlight("0xinflight")
    }
  })

  // Local claim/refund flags can reflect pending-chain txs demoted at cutover — the exit runtime
  // decides spentness from frozen chain state, so these rows must still cross the seam.
  it("includes locally-claimed and locally-refunded rows", async () => {
    vi.spyOn(PaylinkService, "parsePaylinkUrl").mockResolvedValue(decodedParams())
    const rows = await eligibleEscrowRows([
      escrowRow({ txHash: "0xa", isClaimed: true }),
      escrowRow({ txHash: "0xb", isRefunded: true }),
    ])
    expect(rows.map((r) => r.txHash)).toEqual(["0xa", "0xb"])
  })

  it("excludes rows missing material or a create txHash", async () => {
    vi.spyOn(PaylinkService, "parsePaylinkUrl").mockResolvedValue(decodedParams())
    const rows = await eligibleEscrowRows([
      escrowRow({ txHash: "0xa", paylink: undefined }),
      escrowRow({ txHash: "0xb", fallbackSecret: undefined }),
      escrowRow({ txHash: "" }),
    ])
    expect(rows).toEqual([])
  })

  // a malformed-but-present link is dropped at the gate — it must never reach the exit
  // runtime, where a parse failure would fail the whole migration record.
  it("drops a row whose link does not decode, keeping decodable siblings", async () => {
    vi.spyOn(PaylinkService, "parsePaylinkUrl").mockImplementation(async (url: string) => {
      if (url === "https://x/#garbage") throw new Error("Invalid paylink link")
      return decodedParams()
    })
    const rows = await eligibleEscrowRows([
      escrowRow({ txHash: "0xbad", paylink: "https://x/#garbage" }),
      escrowRow({ txHash: "0xgood" }),
    ])
    expect(rows.map((r) => r.txHash)).toEqual(["0xgood"])
  })

  it("ignores non-PAY rows", async () => {
    const spy = vi.spyOn(PaylinkService, "parsePaylinkUrl")
    const claimRow = escrowRow({ txHash: "0xclaim" })
    ;(claimRow as { emailPaymentAction: string }).emailPaymentAction = "Claim Back"
    expect(await eligibleEscrowRows([claimRow])).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("isPaylinkInRefundWindow", () => {
  const row = baseRow({ refundableUntil: 1500 })

  it("true from creation until refundableUntil, boundary inclusive", () => {
    expect(isPaylinkInRefundWindow(row, 0)).toBe(true)
    expect(isPaylinkInRefundWindow(row, 1200)).toBe(true)
    expect(isPaylinkInRefundWindow(row, 1500)).toBe(true)
  })

  it("false once the window has closed", () => {
    expect(isPaylinkInRefundWindow(row, 1501)).toBe(false)
  })

  it("false for a row without a persisted refund window", () => {
    expect(isPaylinkInRefundWindow(baseRow({ refundableUntil: undefined }), 1200)).toBe(false)
  })
})

describe("paylinkWindows", () => {
  it("claims open after the grace, refund spans creation to expiry", () => {
    expect(paylinkWindows(1000n, 500n, 100n)).toEqual({
      fromClaimable: 1100n,
      untilClaimable: 1500n,
      refundableUntil: 1500n,
    })
  })
})
