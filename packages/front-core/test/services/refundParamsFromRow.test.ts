import { describe, it, expect, vi, afterEach } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PaylinkService, type PaylinkParams } from "@obsidion/sdk"
import {
  creatorLinksFromRows,
  refundParamsFromRow,
  isPaylinkInRefundWindow,
  paylinkWindows,
} from "../../src/core/services/paylink/refundParamsFromRow"
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

describe("creatorLinksFromRows", () => {
  it("keeps each creator row's link with its fallback secret, a legacy row included", async () => {
    const [tokened, legacy] = [decodedParams(), decodedParams()]
    vi.spyOn(PaylinkService, "parsePaylinkUrl")
      .mockResolvedValueOnce(tokened)
      .mockResolvedValueOnce(legacy)
    const [first, second] = [Fr.random(), Fr.random()]
    const rows = [
      baseRow({ paylink: "https://x/#a", fallbackSecret: first.toString(), tokenAddress: "0x1" }),
      // Written before rows carried a token address.
      baseRow({ paylink: "https://x/#b", fallbackSecret: second.toString() }),
      // A claimer's row holds no creator secret, and a plain send no link.
      baseRow({ paylink: "https://x/#c", tokenAddress: "0x1" }),
      { action: "send", timestamp: 0, status: "success", txHash: "0xsend" } as never,
    ]
    expect(await creatorLinksFromRows(rows)).toEqual([
      { ...tokened, fallbackSecret: first },
      { ...legacy, fallbackSecret: second },
    ])
  })

  it("skips a row whose link or fallback secret is malformed", async () => {
    vi.spyOn(PaylinkService, "parsePaylinkUrl")
      .mockRejectedValueOnce(new Error("bad link"))
      .mockResolvedValue(decodedParams())
    const rows = [
      baseRow({ paylink: "https://x/#bad", fallbackSecret: Fr.random().toString() }),
      baseRow({ paylink: "https://x/#frag", fallbackSecret: "not-a-field" }),
    ]
    expect(await creatorLinksFromRows(rows)).toEqual([])
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
