// @vitest-environment node
/** Which passkey refusals offer a retry. */
import * as errors from "@obsidion/passkey-web"
import { describe, expect, it } from "vitest"
import { refusalFor } from "../../../src/features/identity/PasskeyRefusal"

describe("refusalFor", () => {
  it("offers no retry where another attempt cannot help", () => {
    expect(refusalFor(new errors.RotatedCredentialError()).retry).toBe(false)
    expect(refusalFor(new errors.AmbiguousPasskeyError()).retry).toBe(false)
    expect(refusalFor(new errors.PhoneRequiredError()).retry).toBe(true)
    expect(refusalFor({ name: "error" }).retry).toBe(true)
  })
})
