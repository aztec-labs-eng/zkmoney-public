/** The Aztec-free derivation against the vectors the sdk's `Fr` derivation is pinned to. */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MSK_PRF_SALT } from "@obsidion/core/constants"
import { afterEach, describe, expect, it, vi } from "vitest"
import { bytesToHex, hexToBytes } from "../src/ceremony/bytes.js"
import {
  contextualize,
  deriveMskFromPrf,
  deriveMskHexFromPrf,
  prfSalts,
} from "../src/policy/derivation.js"

const fixture = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/mskPrfParity.json"),
    "utf8",
  ),
) as {
  saltHex: string
  contextualizedSaltHex: string
  mskReductionVectors: { label: string; prfHex: string; mskHex: string }[]
}

describe("deriveMskFromPrf", () => {
  it("reproduces every shared reduction vector", () => {
    expect(fixture.mskReductionVectors.length).toBeGreaterThanOrEqual(6)
    for (const { label, prfHex, mskHex } of fixture.mskReductionVectors) {
      const prf = hexToBytes(prfHex)
      expect(`0x${bytesToHex(deriveMskFromPrf(prf))}`, label).toBe(mskHex)
      expect(deriveMskHexFromPrf(prf), label).toBe(mskHex)
    }
  })

  it("rejects anything but 32 bytes", () => {
    expect(() => deriveMskFromPrf(new Uint8Array(31))).toThrow(/exactly 32 bytes/)
    expect(() => deriveMskFromPrf(new Uint8Array(33))).toThrow(/exactly 32 bytes/)
  })
})

describe("contextualize", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("matches the fixture's K(C) over the shared salt", async () => {
    expect(bytesToHex(MSK_PRF_SALT)).toBe(fixture.saltHex)
    expect(bytesToHex(await contextualize(MSK_PRF_SALT))).toBe(fixture.contextualizedSaltHex)
  })

  it("hands both salts to every ceremony", async () => {
    const salts = await prfSalts()
    expect(salts.prfFirstSalt).toBe(MSK_PRF_SALT)
    expect(bytesToHex(salts.prfSecondSalt)).toBe(fixture.contextualizedSaltHex)
  })

  it("rejects with a clear error where WebCrypto is missing, then recovers", async () => {
    // A fresh module: the memoised second salt of the suite above would otherwise answer.
    vi.resetModules()
    const fresh = await import("../src/policy/derivation.js")
    vi.stubGlobal("crypto", {})
    await expect(fresh.contextualize(MSK_PRF_SALT)).rejects.toThrow(/crypto\.subtle/)
    await expect(fresh.prfSalts()).rejects.toThrow(/crypto\.subtle/)
    vi.unstubAllGlobals()
    expect(bytesToHex((await fresh.prfSalts()).prfSecondSalt)).toBe(fixture.contextualizedSaltHex)
  })
})
