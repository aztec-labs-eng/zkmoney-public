// @vitest-environment node
/** The verdict the wallet tagged on a stored-address mismatch, which picks the screens' card. */
import { StoredAddressMismatchError } from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import { mismatchVerdictOf } from "../../../src/platform/auth/WebAlphaAuthService"

describe("mismatchVerdictOf", () => {
  it("reads the verdict a mismatch carries", () => {
    const err = Object.assign(new StoredAddressMismatchError(), { verdict: "wrong-key" })
    expect(mismatchVerdictOf(err)).toBe("wrong-key")
    expect(mismatchVerdictOf(new StoredAddressMismatchError())).toBeUndefined()
  })

  it("reads no verdict off any other error, even one with the field", () => {
    expect(
      mismatchVerdictOf(Object.assign(new Error("x"), { verdict: "wrong-key" })),
    ).toBeUndefined()
    expect(mismatchVerdictOf(undefined)).toBeUndefined()
  })
})
