import { describe, expect, it } from "vitest"
import { decodeInline, encodeInline } from "../../src/index.js"
import golden from "./fixtures/inline-golden-vector.json"

/**
 * Golden-vector drift guard for the inline handshake wire format. The SAME
 * fixture is read by the xmtp-bot mirror test (packages/cli/xmtp-bot), so a
 * deliberate-or-accidental change to the encoding fails BOTH — which is the
 * point: the app and the bot must agree byte-for-byte. Regenerate the fixture
 * only when intentionally bumping the wire format.
 */
describe("handshakeInlineCodec golden vector", () => {
  it("decodeInline(fixture.encoded) deep-equals fixture.packet", () => {
    expect(decodeInline(golden.encoded)).toEqual(golden.packet)
  })

  it("encodeInline(fixture.packet) === fixture.encoded (deterministic)", () => {
    expect(encodeInline(golden.packet as Parameters<typeof encodeInline>[0])).toBe(golden.encoded)
  })
})
