import { describe, expect, it } from "vitest"
import { p256 } from "@noble/curves/p256"
import { sha256 } from "@aztec/foundation/crypto/sha256"
import { hexToBytes } from "viem"

import {
  credentialIdToMetadata,
  pubkeyToR1KeyArg,
  toWebAuthnAuthArg,
  type PasskeySignResult,
} from "../../src/oxide/oxideWebAuthn"

// Fixed P-256 key (deterministic).
const PRIV = hexToBytes(`0x${"07".repeat(32)}`)
const PUB = p256.getPublicKey(PRIV, false) // 65 bytes: 0x04 ‖ x ‖ y

const AUTHENTICATOR_DATA = `0x${"ab".repeat(37)}`
const CLIENT_DATA_JSON = `{"type":"webauthn.get","challenge":"AAAA","origin":"https://obsidion"}`

// The exact message the OZ/oxide verifier checks: sha256(authenticatorData ‖ sha256(clientDataJSON)).
function webauthnMessageHash(authenticatorDataHex: string, clientDataJSON: string): Uint8Array {
  const authData = hexToBytes(authenticatorDataHex as `0x${string}`)
  const clientHash = new Uint8Array(sha256(new TextEncoder().encode(clientDataJSON)))
  const message = new Uint8Array(authData.length + clientHash.length)
  message.set(authData)
  message.set(clientHash, authData.length)
  return new Uint8Array(sha256(message))
}

function passkeyResult(r: bigint, s: bigint): PasskeySignResult {
  const rHex = r.toString(16).padStart(64, "0")
  const sHex = s.toString(16).padStart(64, "0")
  return {
    signature: `0x${rHex}${sHex}`,
    webauthn: {
      authenticatorData: AUTHENTICATOR_DATA,
      clientDataJSON: CLIENT_DATA_JSON,
      challengeIndex: CLIENT_DATA_JSON.indexOf('"challenge"'),
      typeIndex: CLIENT_DATA_JSON.indexOf('"type"'),
    },
  }
}

describe("pubkeyToR1KeyArg", () => {
  it("splits a 64-byte x‖y passkey key into {qx,qy}", () => {
    const x = "11".repeat(32)
    const y = "22".repeat(32)
    expect(pubkeyToR1KeyArg(`0x${x}${y}`)).toEqual({ qx: `0x${x}`, qy: `0x${y}` })
    expect(pubkeyToR1KeyArg(`${x}${y}`)).toEqual({ qx: `0x${x}`, qy: `0x${y}` })
  })

  it("rejects a wrong-length key", () => {
    expect(() => pubkeyToR1KeyArg("0xdead")).toThrow(/64-byte/)
  })
})

describe("toWebAuthnAuthArg", () => {
  const msgHash = webauthnMessageHash(AUTHENTICATOR_DATA, CLIENT_DATA_JSON)

  it("produces an arg whose (r,s) verifies against the passkey key over the WebAuthn message hash", () => {
    const sig = p256.sign(msgHash, PRIV, { lowS: true })
    const arg = toWebAuthnAuthArg(passkeyResult(sig.r, sig.s))

    const compact = hexToBytes(`0x${arg.r.slice(2)}${arg.s.slice(2)}`)
    expect(p256.verify(compact, msgHash, PUB)).toBe(true)
    expect(BigInt(arg.s) <= p256.CURVE.n / 2n).toBe(true)
  })

  it("normalizes a high-s authenticator signature back to low-s (still verifies)", () => {
    const sig = p256.sign(msgHash, PRIV, { lowS: true })
    const highS = p256.CURVE.n - sig.s // the malleable sibling an authenticator might emit
    expect(highS > p256.CURVE.n / 2n).toBe(true)

    const arg = toWebAuthnAuthArg(passkeyResult(sig.r, highS))
    expect(BigInt(arg.s)).toBe(sig.s) // folded back to canonical low-s
    const compact = hexToBytes(`0x${arg.r.slice(2)}${arg.s.slice(2)}`)
    expect(p256.verify(compact, msgHash, PUB)).toBe(true)
  })

  it("passes the authenticator-computed indices through as bigint", () => {
    const sig = p256.sign(msgHash, PRIV, { lowS: true })
    const arg = toWebAuthnAuthArg(passkeyResult(sig.r, sig.s))
    expect(arg.challengeIndex).toBe(BigInt(CLIENT_DATA_JSON.indexOf('"challenge"')))
    expect(arg.typeIndex).toBe(BigInt(CLIENT_DATA_JSON.indexOf('"type"')))
    expect(arg.clientDataJSON).toBe(CLIENT_DATA_JSON)
    expect(arg.authenticatorData).toBe(AUTHENTICATOR_DATA)
  })

  it("rejects a wrong-length signature", () => {
    expect(() => toWebAuthnAuthArg({ ...passkeyResult(1n, 1n), signature: "0xdead" })).toThrow(
      /64-byte/,
    )
  })
})

// base64url of raw bytes, no padding — the form WebAuthn hands the wallet.
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

describe("credentialIdToMetadata", () => {
  it("decodes a base64url credential id to its raw bytes as 0x-hex", () => {
    // "cred-id-001" — length 11, so its base64 needs one "=" of padding the url form drops.
    const id = toBase64Url(new TextEncoder().encode("cred-id-001"))
    expect(credentialIdToMetadata(id)).toBe(`0x${Buffer.from("cred-id-001").toString("hex")}`)
  })

  it("handles every padding remainder (0, 1, 2 bytes over a 3-byte group)", () => {
    for (const len of [3, 4, 5]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 5) & 0xff)
      expect(credentialIdToMetadata(toBase64Url(bytes))).toBe(
        `0x${Buffer.from(bytes).toString("hex")}`,
      )
    }
  })

  it("maps the url-safe alphabet (- and _) back to + and /", () => {
    // 0xFB 0xFF 0xBF encodes to "+/+/"→ url-safe "-_-_"; a decoder that skipped the swap would corrupt it.
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf])
    const url = toBase64Url(bytes)
    expect(url).toContain("-")
    expect(url).toContain("_")
    expect(credentialIdToMetadata(url)).toBe(`0x${Buffer.from(bytes).toString("hex")}`)
  })

  it("round-trips arbitrary byte lengths", () => {
    for (let len = 1; len <= 64; len++) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 131 + 7) & 0xff)
      expect(credentialIdToMetadata(toBase64Url(bytes))).toBe(
        `0x${Buffer.from(bytes).toString("hex")}`,
      )
    }
  })

  it("rejects the empty string and non-alphabet input, fail-closed", () => {
    expect(() => credentialIdToMetadata("")).toThrow(/base64url/)
    expect(() => credentialIdToMetadata("has spaces")).toThrow(/base64url/)
    expect(() => credentialIdToMetadata("with=padding")).toThrow(/base64url/)
    expect(() => credentialIdToMetadata("plus+slash/")).toThrow(/base64url/)
  })
})
