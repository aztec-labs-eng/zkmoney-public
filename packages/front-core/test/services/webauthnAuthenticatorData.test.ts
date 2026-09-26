import { describe, expect, it } from "vitest"
import {
  parseAaguid,
  parseAuthenticatorDataFlags,
} from "../../src/core/services/webauthnAuthenticatorData"

function authData(flags: number, length = 37): Uint8Array {
  const buf = new Uint8Array(length)
  buf[32] = flags
  return buf
}

const ICLOUD = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd"

function registration(aaguidHex: string, flags = 0x5d): Uint8Array {
  const buf = authData(flags, 37 + 16 + 2)
  for (let i = 0; i < 16; i++) buf[37 + i] = parseInt(aaguidHex.slice(i * 2, i * 2 + 2), 16)
  return buf
}

describe("parseAaguid", () => {
  it("reads the attested credential block as a hyphenated lowercase uuid", () => {
    expect(parseAaguid(registration(ICLOUD.replace(/-/g, "")))).toBe(ICLOUD)
  })

  it("is unknown without attested data, on an all-zero id, or on a short buffer", () => {
    expect(parseAaguid(registration(ICLOUD.replace(/-/g, ""), 0x1d))).toBeUndefined()
    expect(parseAaguid(registration("0".repeat(32)))).toBeUndefined()
    expect(parseAaguid(authData(0x5d, 37))).toBeUndefined()
    expect(parseAaguid(new Uint8Array(20))).toBeUndefined()
  })
})

describe("parseAuthenticatorDataFlags", () => {
  it("reads BE and BS from a minimal buffer", () => {
    // UP | UV | BE | BS
    const flags = parseAuthenticatorDataFlags(authData(0x1d))
    expect(flags).toEqual({
      backupEligible: true,
      backupState: true,
      attestedCredentialData: false,
    })
  })

  it("distinguishes eligible-but-not-yet-backed-up from backed-up", () => {
    expect(parseAuthenticatorDataFlags(authData(0x0d))).toMatchObject({
      backupEligible: true,
      backupState: false,
    })
    expect(parseAuthenticatorDataFlags(authData(0x05))).toMatchObject({
      backupEligible: false,
      backupState: false,
    })
  })

  it("reports attested credential data on a registration response", () => {
    expect(parseAuthenticatorDataFlags(authData(0x5d, 80)).attestedCredentialData).toBe(true)
  })

  it("throws on a buffer that cannot carry the flags", () => {
    expect(() => parseAuthenticatorDataFlags(new Uint8Array(36))).toThrow(/36 bytes/)
  })
})
