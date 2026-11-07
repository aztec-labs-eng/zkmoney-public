import { AztecPaymentRequestCodec, ConnectBackCodec } from "@obsidion/sdk"
import { describe, expect, it } from "vitest"
import { webXmtpCodecs } from "../../../src/platform/xmtp/codecs"

const typeString = (c: {
  authorityId: string
  typeId: string
  versionMajor: number
  versionMinor: number
}) => `${c.authorityId}/${c.typeId}:${c.versionMajor}.${c.versionMinor}`

describe("web XMTP codec registration", () => {
  it("registers the two shared content types under the ids the inbox driver matches on", () => {
    expect(webXmtpCodecs.map((c) => typeString(c.contentType))).toEqual([
      "obsidion.xyz/connect-back:1.0",
      "obsidion.xyz/payment-request:1.0",
    ])
  })

  it("uses the shared @obsidion/sdk codec bodies directly (no wrapper re-implementation)", () => {
    expect(webXmtpCodecs[0]).toBeInstanceOf(ConnectBackCodec)
    expect(webXmtpCodecs[1]).toBeInstanceOf(AztecPaymentRequestCodec)
  })
})
