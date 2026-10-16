// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { BrowserPasskeyCeremony, DEFAULT_CEREMONY_TIMING } from "../src/ceremony/passkeyCeremony.js"
import {
  DeviceBoundPasskeyError,
  IncompleteCreationError,
  LaptopPasskeyRefusedError,
  NoPrfError,
  PhoneRequiredError,
  RelatedOriginPasskeyError,
  SingleSaltProviderError,
  UnsupportedProviderError,
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

describe("the laptop's own route refusals", () => {
  const managers = ["apple", "gpm"] as const

  it("says why Apple Passwords was refused and names the way out", () => {
    const floor = new LaptopPasskeyRefusedError("apple", ["gpm"])
    expect(floor.name).toBe("LaptopPasskeyRefusedError")
    expect(floor.kind).toBe("apple")
    expect(floor.message).toContain(
      "only on macOS 15.7.5 or a later macOS 15, or macOS 26.4.1 or later. Before those, an " +
        "Apple bug can give a Mac the wrong secret key from a synced passkey, and on macOS 14 " +
        "or earlier it gives none at all.",
    )
    expect(floor.belowMacFloor).toBe(true)
    expect(floor.message).toContain("Google Password Manager (sign in to Chrome first)")
    expect(floor.message).toContain("or use your phone instead")
    expect(floor.message).not.toMatch(/choose Apple Passwords/)
    const withdrawn = new LaptopPasskeyRefusedError("apple", ["gpm"], { appleWithdrawn: true })
    expect(withdrawn.message).toContain("isn't available for a wallet on this browser yet")
    expect(withdrawn.message).not.toMatch(/15\.7\.5|26\.4\.1/)
    expect(withdrawn.belowMacFloor).toBe(false)
    expect(new LaptopPasskeyRefusedError("unnamed", ["gpm"]).belowMacFloor).toBe(false)
  })

  it("explains an unnamed or off-route answer in plain words, naming the managers", () => {
    const unnamed = new LaptopPasskeyRefusedError("unnamed", managers)
    expect(unnamed.message).toContain("couldn't tell which passkey manager saved this one")
    expect(unnamed.message).toContain("Apple Passwords or Google Password Manager")
    expect(unnamed.message).not.toMatch(/15\.7\.5|26\.4\.1/)
    const notLocal = new LaptopPasskeyRefusedError("not-local", managers)
    expect(notLocal.message).toContain("wasn't saved by a password manager on this computer")
    expect(notLocal.message).toContain("or use your phone instead")
    expect(passkeyWritten(markPasskeyWritten(notLocal))).toBe(true)
  })

  it("gives the existing refusals a local-route message built from the managers", () => {
    const local = { localManagers: managers }
    expect(
      new UnsupportedProviderError("manager", { providerName: "Windows Hello", ...local }).message,
    ).toBe(
      "Windows Hello can't protect a wallet yet. Try again and choose Apple Passwords or Google " +
        "Password Manager (sign in to Chrome first), or use your phone instead.",
    )
    expect(
      new UnsupportedProviderError("manager", { providerName: "Windows Hello" }).message,
    ).toContain("iCloud Keychain, Google Password Manager, or 1Password")
    for (const Refusal of [DeviceBoundPasskeyError, NoPrfError, SingleSaltProviderError]) {
      expect(new Refusal(local).message).toContain(
        "Google Password Manager (sign in to Chrome first)",
      )
      expect(new Refusal(local).message).toContain("or use your phone instead")
      expect(new Refusal().message).not.toContain("use your phone instead")
    }
    const unreported = new PhoneRequiredError(local)
    expect(unreported.message).toContain("didn't say where that passkey was saved")
    expect(unreported.message).not.toContain("skip any offer")
    expect(new PhoneRequiredError({ ceremony: "create" }).message).toContain("skip any offer")
  })

  it("names the browser fix for a mislabelled creation, and only the retry for another credential's answer", () => {
    const mislabelled = new IncompleteCreationError()
    expect(mislabelled.kind).toBe("mislabelled")
    expect(mislabelled.message).toContain("Update Safari or use Chrome")
    const other = new IncompleteCreationError("other-credential")
    expect(other.message).not.toContain("Safari")
    expect(other.message).toContain("your new passkey")
    expect(other.name).toBe(mislabelled.name)
  })
})

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
