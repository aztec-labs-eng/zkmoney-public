import { describe, expect, it } from "vitest"
import {
  type Evidence,
  candidatesFrom,
  evidenceOf,
  isComplete,
  preferredSlot,
  prfOutputFor,
} from "../src/policy/evidence.js"

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)
const first = bytes(32, 1)
const second = bytes(32, 2)

describe("evidence", () => {
  it("keeps only the flags, the two slots and the reported class of a result", () => {
    const result = {
      backupEligible: true,
      prfFirst: first,
      authenticatorAttachment: "cross-platform" as const,
      credentialId: "x",
    }
    expect(evidenceOf(result as Evidence & { credentialId: string })).toEqual({
      backupEligible: true,
      prfFirst: first,
      prfSecond: undefined,
      authenticatorAttachment: "cross-platform",
    })
  })

  it("is complete only with readable flags and the bound slot", () => {
    expect(isComplete({ backupEligible: true, prfFirst: first }, "first")).toBe(true)
    expect(isComplete({ backupEligible: false, prfFirst: first }, "first")).toBe(true)
    expect(isComplete({ backupEligible: true, prfFirst: first }, "second")).toBe(false)
    expect(isComplete({ prfFirst: first, prfSecond: second }, "first")).toBe(false)
  })
})

describe("prfOutputFor", () => {
  it("returns the bound slot behind the backup gate", () => {
    expect(
      prfOutputFor({ backupEligible: true, prfFirst: first, prfSecond: second }, "first"),
    ).toBe(first)
    expect(prfOutputFor({ backupEligible: true, prfSecond: second }, "second")).toBe(second)
  })

  it("refuses a device-bound or unreadable passkey before looking at the slots", () => {
    expect(() => prfOutputFor({ backupEligible: false, prfFirst: first }, "first")).toThrow(
      expect.objectContaining({ name: "DeviceBoundPasskeyError" }),
    )
    expect(() => prfOutputFor({ prfFirst: first }, "first")).toThrow(
      expect.objectContaining({ name: "DeviceBoundPasskeyError" }),
    )
  })

  it("lets a security key past the backup gate, but never an unreadable flag", () => {
    expect(prfOutputFor({ backupEligible: false, prfFirst: first }, "first", true)).toBe(first)
    expect(() => prfOutputFor({ prfFirst: first }, "first", true)).toThrow(
      expect.objectContaining({ name: "DeviceBoundPasskeyError" }),
    )
  })

  it("still refuses a security key that returned no usable slot", () => {
    expect(() => prfOutputFor({ backupEligible: false }, "first", true)).toThrow(
      expect.objectContaining({ name: "NoPrfError" }),
    )
    expect(() => prfOutputFor({ backupEligible: false, prfSecond: second }, "first", true)).toThrow(
      expect.objectContaining({ name: "SingleSaltProviderError" }),
    )
  })

  it("tells a one-salt provider from no PRF at all", () => {
    expect(() => prfOutputFor({ backupEligible: true, prfFirst: first }, "second")).toThrow(
      expect.objectContaining({ name: "SingleSaltProviderError" }),
    )
    expect(() => prfOutputFor({ backupEligible: true, prfSecond: second }, "first")).toThrow(
      expect.objectContaining({ name: "SingleSaltProviderError" }),
    )
    expect(() => prfOutputFor({ backupEligible: true }, "first")).toThrow(
      expect.objectContaining({ name: "NoPrfError" }),
    )
  })
})

describe("candidatesFrom", () => {
  it("returns every slot the assertion answered", () => {
    expect(candidatesFrom({ backupEligible: true, prfFirst: first, prfSecond: second })).toEqual({
      first,
      second,
    })
    expect(candidatesFrom({ backupEligible: true, prfSecond: second })).toEqual({ second })
  })

  it("drops a malformed slot and keeps a valid sibling", () => {
    expect(
      candidatesFrom({ backupEligible: true, prfFirst: bytes(31), prfSecond: second }),
    ).toEqual({ second })
    expect(candidatesFrom({ backupEligible: true, prfFirst: first, prfSecond: bytes(33) })).toEqual(
      { first },
    )
    expect(() =>
      candidatesFrom({ backupEligible: true, prfFirst: bytes(31), prfSecond: bytes(0) }),
    ).toThrow(expect.objectContaining({ name: "NoPrfError" }))
  })

  it("applies the backup gate first and refuses an empty answer", () => {
    expect(() => candidatesFrom({ backupEligible: false, prfFirst: first })).toThrow(
      expect.objectContaining({ name: "DeviceBoundPasskeyError" }),
    )
    expect(() => candidatesFrom({ prfFirst: first })).toThrow(
      expect.objectContaining({ name: "DeviceBoundPasskeyError" }),
    )
    expect(() => candidatesFrom({ backupEligible: true })).toThrow(
      expect.objectContaining({ name: "NoPrfError" }),
    )
  })

  it("accepts another device's answer that cannot be backed up, and only that", () => {
    expect(
      candidatesFrom({
        backupEligible: false,
        authenticatorAttachment: "cross-platform",
        prfFirst: first,
      }),
    ).toEqual({ first })
    expect(() =>
      candidatesFrom({
        backupEligible: false,
        authenticatorAttachment: "platform",
        prfFirst: first,
      }),
    ).toThrow(expect.objectContaining({ name: "DeviceBoundPasskeyError" }))
    // Unreadable flags stay a refusal whatever answered.
    expect(() =>
      candidatesFrom({ authenticatorAttachment: "cross-platform", prfFirst: first }),
    ).toThrow(expect.objectContaining({ name: "DeviceBoundPasskeyError" }))
  })
})

describe("preferredSlot", () => {
  it("prefers the record's slot, then the attachment's, then first", () => {
    expect(preferredSlot("platform", "first")).toBe("first")
    expect(preferredSlot("platform")).toBe("second")
    expect(preferredSlot("cross-platform")).toBe("first")
    expect(preferredSlot(undefined)).toBe("first")
  })
})
