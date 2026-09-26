// @vitest-environment node
/**
 * The bridge's wire contract, pinned by the golden fixtures the campaign's tests load too: every
 * valid one passes, every invalid one fails for the reason its name says.
 */
import { readdirSync, readFileSync } from "node:fs"
import { Fr } from "@aztec/aztec.js/fields"
import { describe, expect, it } from "vitest"
import {
  BN254_SCALAR_FIELD_ORDER,
  validateBridgeMessage,
  type BridgeRejection,
} from "@obsidion/passkey-web"

const FIXTURES = new URL("../src/bridge/fixtures/", import.meta.url)
type Fixture = { expect: "valid" | BridgeRejection; rpId: string; message: unknown }
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f, JSON.parse(readFileSync(new URL(f, FIXTURES), "utf8")) as Fixture] as const)

describe("bridge protocol fixtures", () => {
  it("cover every rejection reason at least once", () => {
    const reasons = new Set(fixtures.map(([, fx]) => fx.expect))
    for (const reason of [
      "version",
      "type",
      "nonce",
      "derivedAt",
      "rpId",
      "credentialId",
      "pubkeyHex",
      "candidates",
      "candidate-hex",
      "candidate-order",
      "slot",
      "transports",
    ] satisfies BridgeRejection[]) {
      expect(reasons.has(reason), reason).toBe(true)
    }
    expect(fixtures.filter(([, fx]) => fx.expect === "valid").length).toBeGreaterThanOrEqual(3)
  })

  it.each(fixtures)("%s validates as its name says", (_name, fixture) => {
    const verdict = validateBridgeMessage(fixture.message, { rpId: fixture.rpId })
    if (fixture.expect === "valid") {
      expect(verdict).toMatchObject({ ok: true })
      if (verdict.ok) {
        const message = fixture.message as {
          candidates: unknown
          slot?: unknown
          transports?: unknown
        }
        expect(verdict.message.candidates).toEqual(message.candidates)
        expect(verdict.message.slot).toEqual(message.slot)
        expect(verdict.message.transports).toEqual(message.transports)
      }
    } else {
      expect(verdict).toEqual({ ok: false, reason: fixture.expect })
    }
  })
})

describe("validateBridgeMessage", () => {
  it("refuses what is not an object", () => {
    for (const input of [null, undefined, "x", 1, []]) {
      expect(validateBridgeMessage(input, { rpId: "localhost" })).toEqual({
        ok: false,
        reason: "not-an-object",
      })
    }
  })

  it("keeps only the two slots and drops unknown fields", () => {
    const valid = fixtures.find(([n]) => n === "valid-first-only.json")![1]
    const message = {
      ...(valid.message as object),
      extra: 1,
      candidates: { first: `0x${"11".repeat(32)}`, third: "x" },
    }
    const verdict = validateBridgeMessage(message, { rpId: "localhost" })
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(Object.keys(verdict.message).sort()).toEqual(
        [
          "candidates",
          "credentialId",
          "derivedAt",
          "nonce",
          "pubkeyHex",
          "rpId",
          "type",
          "v",
        ].sort(),
      )
      expect(verdict.message.candidates).toEqual({ first: `0x${"11".repeat(32)}` })
    }
  })

  it.each([
    ["a key", ["usb"]],
    ["a synced passkey", ["hybrid", "internal"]],
    ["a token the wallet does not name", ["future-token"]],
    ["known and unknown tokens together", ["usb", "future-token"]],
    ["a token with a digit", ["usb2"]],
    ["eight tokens, the most admitted", Array.from({ length: 8 }, (_, i) => `t${i}`)],
  ])("keeps the transports of %s verbatim, in order", (_name, transports) => {
    const valid = fixtures.find(([n]) => n === "valid-first-only.json")![1]
    const verdict = validateBridgeMessage(
      { ...(valid.message as object), transports },
      { rpId: "localhost" },
    )
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.message.transports).toEqual(transports)
  })

  it.each([
    ["empty", []],
    ["nine entries", Array.from({ length: 9 }, () => "usb")],
    ["a number among the tokens", ["usb", 1]],
    ["a token with a space", ["smart card"]],
    ["an uppercase token", ["USB"]],
    ["a token starting with a digit", ["1usb"]],
    ["a token longer than sixteen characters", ["a".repeat(17)]],
    ["a string instead of an array", "usb"],
    ["null", null],
    ["a list with a hole", Object.assign(new Array<string>(2), { 1: "usb" })],
  ])("refuses transports that are %s", (_name, transports) => {
    const valid = fixtures.find(([n]) => n === "valid-first-only.json")![1]
    expect(
      validateBridgeMessage({ ...(valid.message as object), transports }, { rpId: "localhost" }),
    ).toEqual({ ok: false, reason: "transports" })
  })

  it("the field order is the wallet's Fr modulus", () => {
    const hex = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`
    expect(() => Fr.fromHexString(hex(BN254_SCALAR_FIELD_ORDER))).toThrow()
    expect(Fr.fromHexString(hex(BN254_SCALAR_FIELD_ORDER - 1n)).toBigInt()).toBe(
      BN254_SCALAR_FIELD_ORDER - 1n,
    )
  })
})
