// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { BrowserPasskeyCeremony, DEFAULT_CEREMONY_TIMING } from "../src/ceremony/passkeyCeremony.js"
import {
  RelatedOriginPasskeyError,
  isExtensionPasskeyError,
  markPasskeyWritten,
  passkeyWritten,
} from "../src/policy/passkeyErrors.js"

const BITWARDEN_FRAME =
  "CredentialsContainer.<anonymous> (chrome-extension://nngceckbapebfimnlniiiahkandclblb/content/fido2-page-script.js:1259:27)"
const PAGE_FRAME = "select (https://launch.zk.money/app.js:1:1)"

const thrownAt = (error: Error, frame: string) => {
  error.stack = `${error.name}: ${error.message}\n    at ${frame}`
  return error
}

describe("isExtensionPasskeyError", () => {
  it.each([
    ["Something went wrong.", BITWARDEN_FRAME],
    ["Unexpected failure", "get@moz-extension://0b6d2f3c/content/fido2-page-script.js:12:3"],
    ["", "get@safari-web-extension://0B6D2F3C/content/fido2-page-script.js:12:3"],
  ])("matches a plain Error %j thrown by an extension script", (message, frame) => {
    expect(isExtensionPasskeyError(thrownAt(new Error(message), frame))).toBe(true)
  })

  it.each([
    ["a page error", thrownAt(new Error("x"), PAGE_FRAME)],
    ["a page error naming an extension", thrownAt(new Error("chrome-extension://x"), PAGE_FRAME)],
    ["a DOMException", thrownAt(new DOMException("x", "NotAllowedError"), BITWARDEN_FRAME)],
    ["a TypeError", thrownAt(new TypeError("boom"), BITWARDEN_FRAME)],
    ["a policy refusal", thrownAt(new RelatedOriginPasskeyError(), BITWARDEN_FRAME)],
    ["a value with no stack", { name: "Error", message: "x" }],
  ])("rejects %s", (_, error) => {
    expect(isExtensionPasskeyError(error)).toBe(false)
  })

  it("still matches after the ceremony rejects with the extension's error", async () => {
    const thrown = thrownAt(new Error("Something went wrong."), BITWARDEN_FRAME)
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get: vi.fn().mockRejectedValue(thrown) },
    })
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    const ceremony = new BrowserPasskeyCeremony(DEFAULT_CEREMONY_TIMING)
    const error = await ceremony
      .assert({ rpId: "localhost", challenge: new Uint8Array(32) })
      .catch((e) => e)
    expect(error).toBe(thrown)
    expect(isExtensionPasskeyError(error)).toBe(true)
  })
})

describe("the written mark", () => {
  it("marks an error and gives it back, and reads it on the error or its cause", () => {
    const refusal = new RelatedOriginPasskeyError()
    expect(markPasskeyWritten(refusal)).toBe(refusal)
    expect(passkeyWritten(refusal)).toBe(true)
    expect(passkeyWritten(new Error("wrapped", { cause: refusal }))).toBe(true)
    const browser = new DOMException("Dismissed", "NotAllowedError")
    expect(passkeyWritten(markPasskeyWritten(browser))).toBe(true)
  })

  it("marks nothing by default, and never a value that is not an object", () => {
    expect(passkeyWritten(new RelatedOriginPasskeyError())).toBe(false)
    expect(passkeyWritten(new Error("plain", { cause: new Error("plain too") }))).toBe(false)
    expect(passkeyWritten(undefined)).toBe(false)
    expect(passkeyWritten("NotAllowedError")).toBe(false)
    expect(markPasskeyWritten("x")).toBe("x")
  })
})
