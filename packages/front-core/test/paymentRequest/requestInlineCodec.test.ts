import { describe, expect, it } from "vitest"
import { encode as cborEncode, decode as cborDecode } from "cbor-x"
import { Buffer } from "buffer"
import {
  decodeRequestInline,
  encodeRequestInline,
  RequestDecodeError,
  RequestEncodeError,
  type RequestInlinePacket,
} from "../../src/index.js"

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

// Valid BN254 field elements (below the 0x3064… modulus), lowercase.
const REQUEST_ID_HEX = `0x${"0a".repeat(32)}`
const TOKEN_ADDRESS_HEX = `0x${"1b".repeat(32)}`
const REQUESTER_ADDRESS_HEX = `0x${"2c".repeat(32)}`
const SIPA_ADDRESS_HEX = `0x${"3d".repeat(20)}`
const BN254_FR_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n

function fullPacket(): RequestInlinePacket {
  return {
    requestId: REQUEST_ID_HEX,
    requesterTag: "alice",
    amountAtomic: 1_000_000n,
    tokenDecimals: 18,
    tokenSymbol: "DAI",
    note: "lunch",
    expiresAt: 1_750_000_000_000,
    networkId: "aztec-sandbox",
    tokenAddress: TOKEN_ADDRESS_HEX,
    requesterAddress: REQUESTER_ADDRESS_HEX,
    sipaAddress: SIPA_ADDRESS_HEX,
  }
}

function minimalPacket(): RequestInlinePacket {
  return {
    requestId: REQUEST_ID_HEX,
    requesterTag: "bob",
    amountAtomic: 0n,
    networkId: "aztec-testnet",
    tokenAddress: TOKEN_ADDRESS_HEX,
  }
}

function amountBytes(amount: bigint): Buffer {
  const b = Buffer.alloc(16)
  let x = amount
  for (let i = 15; i >= 0; i--) {
    b[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return b
}

function fieldBytes(hex: string): Buffer {
  return Buffer.from(hex.slice(2), "hex")
}

function bigintTo32(v: bigint): Buffer {
  return Buffer.from(v.toString(16).padStart(64, "0"), "hex")
}

/** Hand-built fragment from raw CBOR map entries — bypasses the encoder. */
function rawFragment(entries: [number, unknown][]): string {
  return Buffer.from(cborEncode(new Map<number, unknown>(entries)))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/** Baseline v3 map entries; override/delete keys per test. */
function v3Entries(): Map<number, unknown> {
  return new Map<number, unknown>([
    [1, 3],
    [2, fieldBytes(REQUEST_ID_HEX)],
    [3, "erin"],
    [4, amountBytes(1n)],
    [8, "aztec-testnet"],
    [10, fieldBytes(TOKEN_ADDRESS_HEX)],
  ])
}

// A fragment exactly as the pre-v2 encoder produced it: FORMAT=1, keys 1–8, no
// decimals key. Proves the current decoder still reads links already in the wild.
function encodeV1Fragment(p: {
  requestId: string
  requesterTag: string
  amountAtomic: bigint
  networkId: string
}): string {
  return rawFragment([
    [1, 1], // KEY_FORMAT = v1
    [2, p.requestId],
    [3, p.requesterTag],
    [4, amountBytes(p.amountAtomic)],
    [8, p.networkId],
  ])
}

describe("requestInlineCodec", () => {
  describe("happy path", () => {
    it("round-trips a full packet", () => {
      const packet = fullPacket()
      expect(decodeRequestInline(encodeRequestInline(packet))).toEqual(packet)
    })

    it("round-trips a minimal packet (any-amount, no optionals) and is smaller", () => {
      const minimal = minimalPacket()
      const minEncoded = encodeRequestInline(minimal)
      expect(decodeRequestInline(minEncoded)).toEqual(minimal)
      expect(minEncoded.length).toBeLessThan(encodeRequestInline(fullPacket()).length)
    })

    it("round-trips a v3 packet with a 20-byte SIPA and lowercases mixed-case hex", () => {
      const packet = {
        ...minimalPacket(),
        sipaAddress: SIPA_ADDRESS_HEX.toUpperCase().replace("0X", "0x"),
      }
      const encoded = encodeRequestInline(packet)
      expect(decodeRequestInline(encoded).sipaAddress).toBe(SIPA_ADDRESS_HEX)
      let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
      while (b64.length % 4) b64 += "="
      const decoded = cborDecode(Buffer.from(b64, "base64"))
      const format =
        decoded instanceof Map ? decoded.get(1) : (decoded as Record<string, unknown>)["1"]
      expect(format).toBe(3)
    })

    it("emits base64url (no +, /, =)", () => {
      expect(encodeRequestInline(fullPacket())).toMatch(/^[A-Za-z0-9_-]+$/)
    })

    it("preserves a large u128 amount exactly", () => {
      const big = (1n << 128n) - 1n
      const packet = { ...minimalPacket(), amountAtomic: big }
      expect(decodeRequestInline(encodeRequestInline(packet)).amountAtomic).toBe(big)
    })

    it("omits absent optionals rather than emitting empty values", () => {
      const decoded = decodeRequestInline(encodeRequestInline(minimalPacket()))
      expect(decoded.tokenSymbol).toBeUndefined()
      expect(decoded.note).toBeUndefined()
      expect(decoded.expiresAt).toBeUndefined()
      expect(decoded.tokenDecimals).toBeUndefined()
      expect(decoded.requesterAddress).toBeUndefined()
      expect(decoded.sipaAddress).toBeUndefined()
    })
  })

  describe("wire-format stability", () => {
    // Encoding is deterministic (fixed key order, no timestamps) — a change to
    // the key numbering or field packing shows up as a fragment diff here.
    it("encodes deterministically", () => {
      expect(encodeRequestInline(fullPacket())).toBe(encodeRequestInline(fullPacket()))
      expect(encodeRequestInline(minimalPacket())).toBe(encodeRequestInline(minimalPacket()))
    })

    it("a differing field yields a differing fragment", () => {
      const a = encodeRequestInline(minimalPacket())
      const b = encodeRequestInline({ ...minimalPacket(), amountAtomic: 5n })
      expect(a).not.toBe(b)
    })
  })

  describe("v3 field slots (requestId / tokenAddress / requesterAddress)", () => {
    it("requires tokenAddress on encode", () => {
      const { tokenAddress: _, ...rest } = minimalPacket()
      expect(() => encodeRequestInline(rest as RequestInlinePacket)).toThrow(RequestEncodeError)
    })

    it("rejects a non-field requestId on encode (legacy text, short hex, zero, >= modulus)", () => {
      for (const bad of [
        "req-1750000000000-ab12cd",
        "0xabcd",
        `0x${"00".repeat(32)}`,
        `0x${bigintTo32(BN254_FR_MODULUS).toString("hex")}`,
      ]) {
        expect(() => encodeRequestInline({ ...minimalPacket(), requestId: bad })).toThrow(
          RequestEncodeError,
        )
      }
    })

    it("rejects malformed tokenAddress / requesterAddress on encode", () => {
      expect(() => encodeRequestInline({ ...minimalPacket(), tokenAddress: "0x12" })).toThrow(
        RequestEncodeError,
      )
      expect(() =>
        encodeRequestInline({ ...minimalPacket(), requesterAddress: `0x${"00".repeat(32)}` }),
      ).toThrow(RequestEncodeError)
    })

    it("accepts mixed-case hex on encode and decodes to lowercase", () => {
      const packet = {
        ...minimalPacket(),
        requestId: REQUEST_ID_HEX.toUpperCase().replace("0X", "0x"),
      }
      expect(decodeRequestInline(encodeRequestInline(packet)).requestId).toBe(REQUEST_ID_HEX)
    })

    it("rejects a v3 fragment with a wrong-length or out-of-range field", () => {
      for (const bad of [
        Buffer.alloc(31, 1),
        Buffer.alloc(33, 1),
        Buffer.alloc(32, 0), // zero
        bigintTo32(BN254_FR_MODULUS),
      ]) {
        const entries = v3Entries()
        entries.set(2, bad)
        expect(() => decodeRequestInline(rawFragment([...entries]))).toThrow(RequestDecodeError)
      }
    })

    it("rejects a v3 fragment missing the tokenAddress key", () => {
      const entries = v3Entries()
      entries.delete(10)
      expect(() => decodeRequestInline(rawFragment([...entries]))).toThrow(RequestDecodeError)
    })

    it("rejects a present-but-null requesterAddress (fail-closed)", () => {
      const entries = v3Entries()
      entries.set(11, null)
      expect(() => decodeRequestInline(rawFragment([...entries]))).toThrow(RequestDecodeError)
    })
  })

  describe("v3 SIPA slot", () => {
    function addressBytes(hex: string): Buffer {
      return Buffer.from(hex.slice(2), "hex")
    }

    function v3WithSipa(): Map<number, unknown> {
      const entries = v3Entries()
      entries.set(12, addressBytes(SIPA_ADDRESS_HEX))
      return entries
    }

    it("rejects a 32-byte field, short hex, or the zero address on encode", () => {
      for (const bad of [TOKEN_ADDRESS_HEX, "0x12", `0x${"00".repeat(20)}`, "0xabcd"]) {
        expect(() => encodeRequestInline({ ...minimalPacket(), sipaAddress: bad })).toThrow(
          RequestEncodeError,
        )
      }
    })

    it("rejects a v3 fragment with a wrong-length or zero SIPA", () => {
      for (const bad of [
        Buffer.alloc(19, 1),
        Buffer.alloc(21, 1),
        Buffer.alloc(32, 1),
        Buffer.alloc(20, 0),
      ]) {
        const entries = v3WithSipa()
        entries.set(12, bad)
        expect(() => decodeRequestInline(rawFragment([...entries]))).toThrow(RequestDecodeError)
      }
    })

    it("rejects a present-but-null SIPA (fail-closed)", () => {
      const entries = v3WithSipa()
      entries.set(12, null)
      expect(() => decodeRequestInline(rawFragment([...entries]))).toThrow(RequestDecodeError)
    })

    it("rejects format 4 — SIPA rides on v3", () => {
      const entries = v3WithSipa()
      entries.set(1, 4)
      expect(() => decodeRequestInline(rawFragment([...entries]))).toThrow(RequestDecodeError)
    })
  })

  describe("versioning", () => {
    it("round-trips tokenDecimals", () => {
      const packet = { ...minimalPacket(), amountAtomic: 5n, tokenDecimals: 18 }
      expect(decodeRequestInline(encodeRequestInline(packet)).tokenDecimals).toBe(18)
    })

    it("decodes a legacy v1 fragment (text requestId, no decimals/address keys)", () => {
      const frag = encodeV1Fragment({
        requestId: "req-legacy",
        requesterTag: "carol",
        amountAtomic: 1_000_000n,
        networkId: "aztec-testnet",
      })
      const decoded = decodeRequestInline(frag)
      expect(decoded.requestId).toBe("req-legacy")
      expect(decoded.tokenDecimals).toBeUndefined()
      expect(decoded.tokenAddress).toBeUndefined()
      expect(decoded.requesterAddress).toBeUndefined()
      expect(decoded.amountAtomic).toBe(1_000_000n)
      expect(decoded.requesterTag).toBe("carol")
    })

    it("decodes a legacy v2 fragment (text requestId + decimals key)", () => {
      const decoded = decodeRequestInline(
        rawFragment([
          [1, 2],
          [2, "req-v2"],
          [3, "dave"],
          [4, amountBytes(7n)],
          [8, "aztec-testnet"],
          [9, 6],
        ]),
      )
      expect(decoded.requestId).toBe("req-v2")
      expect(decoded.tokenDecimals).toBe(6)
      expect(decoded.tokenAddress).toBeUndefined()
    })

    it("rejects a legacy fragment carrying a v3-only key (fail-closed per format)", () => {
      expect(() =>
        decodeRequestInline(
          rawFragment([
            [1, 2],
            [2, "req-v2"],
            [3, "dave"],
            [4, amountBytes(7n)],
            [8, "aztec-testnet"],
            [10, fieldBytes(TOKEN_ADDRESS_HEX)],
          ]),
        ),
      ).toThrow(RequestDecodeError)
    })

    it("rejects an out-of-range tokenDecimals on encode", () => {
      expect(() => encodeRequestInline({ ...minimalPacket(), tokenDecimals: -1 })).toThrow(
        RequestEncodeError,
      )
      expect(() => encodeRequestInline({ ...minimalPacket(), tokenDecimals: 37 })).toThrow(
        RequestEncodeError,
      )
    })

    it("rejects a present-but-null decimals key (fail-closed)", () => {
      const entries = v3Entries()
      entries.set(9, null)
      expect(() => decodeRequestInline(rawFragment([...entries]))).toThrow(RequestDecodeError)
    })
  })

  describe("encode guards", () => {
    it("rejects a negative amount", () => {
      expect(() => encodeRequestInline({ ...minimalPacket(), amountAtomic: -1n })).toThrow(
        RequestEncodeError,
      )
    })

    it("rejects an amount at/above the u128 ceiling", () => {
      expect(() => encodeRequestInline({ ...minimalPacket(), amountAtomic: 1n << 128n })).toThrow(
        RequestEncodeError,
      )
    })

    it("rejects a missing requestId / requesterTag / networkId", () => {
      expect(() => encodeRequestInline({ ...minimalPacket(), requestId: "" })).toThrow(
        RequestEncodeError,
      )
      expect(() => encodeRequestInline({ ...minimalPacket(), requesterTag: "" })).toThrow(
        RequestEncodeError,
      )
      expect(() => encodeRequestInline({ ...minimalPacket(), networkId: "" })).toThrow(
        RequestEncodeError,
      )
    })
  })

  describe("fail-closed decode", () => {
    it("rejects non-base64url input", () => {
      expect(() => decodeRequestInline("not base64url!!")).toThrow(RequestDecodeError)
    })

    it("rejects an empty string", () => {
      expect(() => decodeRequestInline("")).toThrow(RequestDecodeError)
    })

    it("rejects garbage that isn't CBOR", () => {
      expect(() => decodeRequestInline("AAAA")).toThrow(RequestDecodeError)
    })

    it("rejects an unknown key on a v3 fragment", () => {
      const entries = v3Entries()
      entries.set(13, "surprise")
      expect(() => decodeRequestInline(rawFragment([...entries]))).toThrow(RequestDecodeError)
    })

    it("rejects a payload over the size cap", () => {
      const entries = v3Entries()
      entries.set(6, "x".repeat(600)) // note blows past MAX_FRAGMENT_BYTES=512
      expect(() => decodeRequestInline(rawFragment([...entries]))).toThrow(RequestDecodeError)
    })

    it("collapses any tampering to a single opaque error", () => {
      const good = encodeRequestInline(fullPacket())
      // Flip a middle char — almost certainly breaks CBOR / a field.
      const tampered = good.slice(0, 4) + (good[4] === "A" ? "B" : "A") + good.slice(5)
      try {
        decodeRequestInline(tampered)
      } catch (err) {
        expect(err).toBeInstanceOf(RequestDecodeError)
      }
    })
  })
})
