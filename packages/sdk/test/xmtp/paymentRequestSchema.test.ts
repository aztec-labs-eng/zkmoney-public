import { describe, expect, it } from "vitest"

import { AztecPaymentRequestContentSchema } from "../../src/xmtp/types.js"

const request = (requestId: string) => ({
  kind: "request" as const,
  requestId,
  requesterTag: "alice",
  amountAtomic: "1",
  token: "0x01",
  decimals: 18,
  networkId: "sandbox",
})

describe("AztecPaymentRequestContentSchema", () => {
  it("rejects a 32-byte hex request id outside the BN254 field", () => {
    expect(
      AztecPaymentRequestContentSchema.safeParse(request(`0x${"ff".repeat(32)}`)).success,
    ).toBe(false)
  })
})
