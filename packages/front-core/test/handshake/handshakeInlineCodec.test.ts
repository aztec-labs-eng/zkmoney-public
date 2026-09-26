import { describe, expect, it } from "vitest"
import {
  CHAIN_TO_CBOR,
  FORMAT_TO_CBOR,
  KIND_TO_CBOR,
  decodeInline,
  encodeInline,
  HandshakeDecodeError,
  HandshakeEncodeError,
  type HandshakeInlinePacket,
} from "../../src/index.js"

/* -------------------------------------------------------------------------- */
/*  Fixtures (canonical, valid)                                               */
/* -------------------------------------------------------------------------- */

// EIP-55 mixed-case checksummed EVM addresses (canonical casing must survive).
const XMTP = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const STEALTH = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"
// Valid Aztec L2 address (< Fr modulus), mixed hex.
const L2 = "0x0c1d2e3f405162738495a6b7c8d9eafb0c1d2e3f405162738495a6b7c8d9eafb"
const UUID = "01234567-89ab-4def-8123-456789abcdef"

function fullPacket(): HandshakeInlinePacket {
  return {
    version: "1.0:testnet",
    kind: "handshake",
    xmtpHandle: XMTP,
    uuid: UUID,
    stealthAddress: STEALTH,
    l2Address: L2,
    time: 1_750_000_000_000,
    tag: "alice",
  }
}

function minimalPacket(): HandshakeInlinePacket {
  return {
    version: "1.0:testnet",
    kind: "handshake",
    xmtpHandle: XMTP,
    uuid: UUID,
  }
}

describe("handshakeInlineCodec", () => {
  describe("happy path", () => {
    it("round-trips a full packet (with l2Address + time) byte-identically", () => {
      const packet = fullPacket()
      const decoded = decodeInline(encodeInline(packet))
      expect(decoded).toEqual(packet)
    })

    it("round-trips a minimal packet and is materially smaller than the full one", () => {
      const minimal = minimalPacket()
      const minEncoded = encodeInline(minimal)
      expect(decodeInline(minEncoded)).toEqual(minimal)
      // Omitting optionals (stealth + l2 + time) must shrink the payload.
      expect(minEncoded.length).toBeLessThan(encodeInline(fullPacket()).length)
    })

    it("produces a URL-safe base64url fragment (no +/= chars)", () => {
      const encoded = encodeInline(fullPacket())
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    })
  })

  describe("format / chain / kind mapping", () => {
    it("maps each chain value to its pinned int and reconstructs version", () => {
      for (const chain of Object.keys(CHAIN_TO_CBOR)) {
        const packet = { ...minimalPacket(), version: `1.0:${chain}` }
        expect(decodeInline(encodeInline(packet)).version).toBe(`1.0:${chain}`)
      }
    })

    it("pins the wire ints (guards accidental renumbering)", () => {
      expect(FORMAT_TO_CBOR).toEqual({ "1.0": 1 })
      expect(CHAIN_TO_CBOR).toEqual({ sandbox: 0, testnet: 1, mainnet: 2 })
      expect(KIND_TO_CBOR).toEqual({ handshake: 0 })
    })

    it("round-trips kind:handshake", () => {
      expect(decodeInline(encodeInline(minimalPacket())).kind).toBe("handshake")
    })
  })

  describe("canonical address casing", () => {
    it("preserves EVM EIP-55 checksum casing through byte→string", () => {
      const decoded = decodeInline(encodeInline(fullPacket()))
      // Exact-string equality — NOT lowercase.
      expect(decoded.xmtpHandle).toBe(XMTP)
      expect(decoded.stealthAddress).toBe(STEALTH)
    })

    it("survives an L2 address byte→string round-trip canonically", () => {
      const decoded = decodeInline(encodeInline(fullPacket()))
      expect(decoded.l2Address).toBe(L2)
    })

    it("normalizes a lowercase EVM input to canonical checksum on decode", () => {
      const lower = { ...minimalPacket(), xmtpHandle: XMTP.toLowerCase() }
      // encode accepts lowercase; decode returns canonical checksum.
      expect(decodeInline(encodeInline(lower)).xmtpHandle).toBe(XMTP)
    })
  })

  describe("fail-closed decode", () => {
    it("rejects an unknown chain int", () => {
      // Re-encode a packet then tamper is hard; instead assert encode rejects an
      // unknown chain and decode rejects a hand-built unknown-int packet.
      expect(() => encodeInline({ ...minimalPacket(), version: "1.0:l2-mainnet" })).toThrow(
        HandshakeEncodeError,
      )
    })

    it("rejects an unknown format on encode", () => {
      expect(() => encodeInline({ ...minimalPacket(), version: "9.9:testnet" })).toThrow(
        HandshakeEncodeError,
      )
    })

    it("rejects an unsupported kind on encode (privacy not yet assigned)", () => {
      // @ts-expect-error — exercising a runtime kind outside the live union.
      expect(() => encodeInline({ ...minimalPacket(), kind: "privacy" })).toThrow(
        HandshakeEncodeError,
      )
    })

    it("rejects old 32-char hex UUIDs on encode", () => {
      expect(() =>
        encodeInline({ ...minimalPacket(), uuid: "0123456789abcdef0123456789abcdef" }),
      ).toThrow(HandshakeEncodeError)
    })

    it("rejects truncated / garbage base64url (no partial object)", () => {
      expect(() => decodeInline("!!!not base64url!!!")).toThrow(HandshakeDecodeError)
      expect(() => decodeInline("")).toThrow(HandshakeDecodeError)
      const good = encodeInline(fullPacket())
      // Truncate mid-CBOR.
      expect(() => decodeInline(good.slice(0, Math.floor(good.length / 2)))).toThrow(
        HandshakeDecodeError,
      )
    })

    it("rejects a non-map top-level CBOR value", async () => {
      // base64url(CBOR of the integer 42) → not a map.
      const { encode } = await importCbor()
      const b64 = toB64Url(encode(42))
      expect(() => decodeInline(b64)).toThrow(HandshakeDecodeError)
    })
  })
})

/* -------------------------------------------------------------------------- */
/*  Tamper helpers — build raw CBOR maps the public encoder won't emit, to    */
/*  prove decode is the single fail-closed enforcement point.                 */
/* -------------------------------------------------------------------------- */

async function importCbor() {
  return await import("cbor-x")
}

describe("tag field", () => {
  it("round-trips a tag and omits the key entirely when absent", () => {
    expect(decodeInline(encodeInline(fullPacket())).tag).toBe("alice")
    expect(decodeInline(encodeInline(minimalPacket())).tag).toBeUndefined()
  })

  it("accepts the full registry charset (digits, leading underscore, inner hyphen, 32 chars)", () => {
    for (const tag of ["a", "honk-goose", "_ab-c9", "a".repeat(32)]) {
      expect(decodeInline(encodeInline({ ...minimalPacket(), tag })).tag).toBe(tag)
    }
  })

  it("rejects a tag outside the registry charset on ENCODE (a bad mint fails loudly)", () => {
    // Uppercase, leading/trailing hyphen, empty, oversized, the two shapes ENSIP-15 fences
    // (inner underscore, 3rd/4th-position `--`), and the homograph/RTL/whitespace shapes a host
    // label could never have carried.
    for (const tag of [
      "Alice",
      "-alice",
      "alice-",
      "",
      "a".repeat(33),
      "a_b",
      "xn--foo",
      "аlice",
      "al\u202Eice",
      " alice",
      "ali ce",
      "alice.",
    ]) {
      expect(() => encodeInline({ ...minimalPacket(), tag })).toThrow(HandshakeEncodeError)
    }
  })
})

describe("handshakeInlineCodec — tampered tag rejects", () => {
  // A tampered packet is the real threat: `verifyTag` folds an invalid tag into "unregistered",
  // which would SKIP the registry cross-check. The codec must reject before it gets there.
  it("rejects an out-of-charset tag on DECODE", async () => {
    const { encode } = await importCbor()
    for (const tag of [
      "Alice",
      "аlice",
      "-alice",
      "",
      "a".repeat(33),
      "a_b",
      "xn--foo",
      "al\u202Eice",
    ]) {
      const m = baseMap()
      m.set(9, tag)
      expect(() => decodeInline(toB64Url(encode(m)))).toThrow(HandshakeDecodeError)
    }
  })

  it("rejects a non-string tag on DECODE", async () => {
    const { encode } = await importCbor()
    for (const tag of [42, true, hexBytes(XMTP), ["alice"]]) {
      const m = baseMap()
      m.set(9, tag)
      expect(() => decodeInline(toB64Url(encode(m)))).toThrow(HandshakeDecodeError)
    }
  })

  it("accepts a valid tag on the wire (the guard is not blanket-rejecting key 9)", async () => {
    const { encode } = await importCbor()
    const m = baseMap()
    m.set(9, "alice")
    expect(decodeInline(toB64Url(encode(m))).tag).toBe("alice")
  })
})

function toB64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

describe("handshakeInlineCodec — tampered wire maps reject", () => {
  it("rejects an unknown kind int at the codec (not just the scan hook)", async () => {
    const { encode } = await importCbor()
    const m = baseMap()
    m.set(3, 7) // kind 7 unknown
    expect(() => decodeInline(toB64Url(encode(m)))).toThrow(HandshakeDecodeError)
  })

  it("rejects an unknown chain int", async () => {
    const { encode } = await importCbor()
    const m = baseMap()
    m.set(2, 99)
    expect(() => decodeInline(toB64Url(encode(m)))).toThrow(HandshakeDecodeError)
  })

  it("rejects an unknown map key", async () => {
    const { encode } = await importCbor()
    const m = baseMap()
    m.set(42, 1) // reserved/unknown key
    expect(() => decodeInline(toB64Url(encode(m)))).toThrow(HandshakeDecodeError)
  })

  it("rejects a missing required field", async () => {
    const { encode } = await importCbor()
    const m = baseMap()
    m.delete(5) // drop uuid
    expect(() => decodeInline(toB64Url(encode(m)))).toThrow(HandshakeDecodeError)
  })

  it("rejects a wrong-length xmtp byte string", async () => {
    const { encode } = await importCbor()
    const m = baseMap()
    m.set(4, new Uint8Array(19)) // 19 != 20
    expect(() => decodeInline(toB64Url(encode(m)))).toThrow(HandshakeDecodeError)
  })

  it("rejects a wrong-length uuid byte string", async () => {
    const { encode } = await importCbor()
    const m = baseMap()
    m.set(5, new Uint8Array(15))
    expect(() => decodeInline(toB64Url(encode(m)))).toThrow(HandshakeDecodeError)
  })

  it("rejects uuid bytes that are not UUID v4", async () => {
    const { encode } = await importCbor()
    const m = baseMap()
    m.set(5, hexBytes("0x0123456789abcdef0123456789abcdef"))
    expect(() => decodeInline(toB64Url(encode(m)))).toThrow(HandshakeDecodeError)
  })

  it("rejects an all-zero xmtp address (passes length, fails sentinel check)", async () => {
    const { encode } = await importCbor()
    const m = baseMap()
    m.set(4, new Uint8Array(20)) // all zero
    expect(() => decodeInline(toB64Url(encode(m)))).toThrow(HandshakeDecodeError)
  })

  it("rejects an all-zero l2 address", async () => {
    const { encode } = await importCbor()
    const m = baseMap()
    m.set(7, new Uint8Array(32)) // all zero
    expect(() => decodeInline(toB64Url(encode(m)))).toThrow(HandshakeDecodeError)
  })
})

/** A minimal VALID wire map (keys 1..5) that decodes; tests then mutate it. */
function baseMap(): Map<number, unknown> {
  const m = new Map<number, unknown>()
  m.set(1, 1) // format 1.0
  m.set(2, 1) // chain testnet
  m.set(3, 0) // kind handshake
  m.set(4, hexBytes(XMTP)) // xmtp 20B
  m.set(5, hexBytes(`0x${UUID.replaceAll("-", "")}`)) // uuid 16B
  return m
}

function hexBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "")
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
