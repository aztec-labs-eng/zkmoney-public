// @vitest-environment node
// The sign-in cards a browser earns: a Windows manager's advice, and an app's built-in browser.
import { afterEach, describe, expect, it } from "vitest"
import { DeviceBoundPasskeyError, NoPrfError } from "@obsidion/passkey-web"
import copy from "../../../src/features/onboarding/EnterAppScreen/EnterAppScreen.copy"
import {
  classifyEntryFailure,
  type SignInKind,
} from "../../../src/features/onboarding/EnterAppScreen/signInSettle"
import { walletInAppUpFront } from "../../../src/features/identity/inAppUpFront"
import { committed, seedDeviceKeys } from "../../support/page"
import { onePasswordCreate, otherCreate } from "../../support/passkeyExtensionStubs"
import { remember } from "../../support/signIn"
import { asBrowser, signInSuite } from "../../support/signInFlow"

signInSuite()

const UA = {
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  // Chrome itself: a browser the in-app rule misses, so a request runs and can fail there.
  androidChrome:
    "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
  // An app's web view on the System WebView, with `wv` stripped: only its Chrome major tells.
  androidChromeStale:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
  iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
  iosInstagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 370.0.0.0.0 (iPhone15,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556; 000000000)",
}
const classify = (e: unknown, kind: SignInKind = "enter") => classifyEntryFailure(e, kind, "alice")
const closed = () => new DOMException("closed", "NotAllowedError")
const unsupported = () =>
  new DOMException("Error connecting to Web Authentication service", "NotSupportedError")

describe("a Windows sign-in refused for want of key material", () => {
  const noPrf = (attachment?: string) => {
    const e = new NoPrfError()
    return attachment ? Object.assign(e, { observed: { credentialId: "id", attachment } }) : e
  }
  const install = (value: unknown) =>
    Object.defineProperty(navigator, "credentials", { value, configurable: true })
  afterEach(() => void delete (navigator as { credentials?: unknown }).credentials)

  it.each([
    ["names the extension's pop-up where 1Password's script answers", onePasswordCreate, "use"],
    [
      "says to install the extension where another manager's script answers",
      otherCreate,
      "install",
    ],
  ] as const)("where this computer answered, %s", (_l, create, advice) => {
    asBrowser(UA.windows)
    install({ create: create() })
    expect(classify(noPrf("platform")).refusal).toMatchObject({
      name: "NoPrfError",
      extensionAdvice: advice,
    })
  })

  it("gets no advice when another device answered, when nothing says what answered, or for another refusal", () => {
    asBrowser(UA.windows)
    install({ get: async () => null })
    expect(classify(noPrf("cross-platform")).refusal?.extensionAdvice).toBeUndefined()
    expect(classify(noPrf()).refusal?.extensionAdvice).toBeUndefined()
    const bound = Object.assign(new DeviceBoundPasskeyError(), {
      observed: { credentialId: "id", attachment: "platform" },
    })
    expect(classify(bound).refusal).toMatchObject({ name: "DeviceBoundPasskeyError" })
    expect(classify(bound).refusal?.extensionAdvice).toBeUndefined()
  })

  it("gets no advice on Linux, which has no Windows passkey window", () => {
    asBrowser(UA.linux)
    install({ get: async () => null })
    expect(classify(noPrf("platform")).refusal?.extensionAdvice).toBeUndefined()
  })
})

describe("an app's built-in browser", () => {
  const upFront = () => walletInAppUpFront(committed(), "localhost")

  it.each([
    ["an iPhone app's browser is told to leave", UA.iosInstagram, "leave"],
    [
      "a stale Chrome with no brands is told to leave or update",
      UA.androidChromeStale,
      "leave-or-update",
    ],
    ["Chrome itself is not told", UA.androidChrome, undefined],
  ])("with no passkey record here, %s before any prompt", (_l, userAgent, mode) => {
    asBrowser(userAgent)
    expect(upFront()).toBe(mode)
  })

  it.each([
    ["a remembered account", () => remember({ credentialId: "cred-bob", usertag: "bob" })],
    ["a nameless account", () => remember({ credentialId: "cred-nameless" })],
    ["the credential the session was entered with", () => seedDeviceKeys({ credentialId: "cred" })],
  ])("%s means a passkey worked here: no card up front", async (_l, seed) => {
    asBrowser(UA.iosInstagram)
    await seed()
    expect(upFront()).toBeUndefined()
  })

  it.each<[string, string, () => unknown, SignInKind, object]>([
    [
      "a request refused as not supported",
      UA.androidChrome,
      unsupported,
      "enter",
      { code: "unknown", refusal: { name: "NotSupportedError" } },
    ],
    [
      "a pinned request refused as not supported",
      UA.androidChrome,
      unsupported,
      "pinned",
      { code: "unknown", refusal: { name: "NotSupportedError" } },
    ],
    [
      "an iPhone app's sheet that closed at once",
      UA.iosInstagram,
      closed,
      "enter",
      { code: "passkey_prompt_closed", refusal: { name: "InAppBrowser" } },
    ],
    [
      "a pinned iPhone app's sheet that closed at once",
      UA.iosX,
      closed,
      "pinned",
      { code: "passkey_not_on_device", refusal: { name: "InAppBrowser" } },
    ],
    [
      "an abort in an iPhone app's browser",
      UA.iosX,
      () => new DOMException("aborted", "AbortError"),
      "enter",
      { code: "passkey_prompt_closed", refusal: { name: "PasskeyNotOfferedError" } },
    ],
  ])("%s gets its card, unreported", (_l, userAgent, error, kind, expected) => {
    asBrowser(userAgent)
    const failed = classify(error(), kind)
    expect(failed).toMatchObject(expected)
    expect(failed.reported).toBeUndefined()
  })

  it("a not-supported failure after the passkey committed keeps the re-probe card, reported", () => {
    asBrowser(UA.androidChrome)
    const failed = classify(Object.assign(unsupported(), { committed: true }))
    expect(failed).toMatchObject({
      reported: true,
      refusal: { name: "error", probeCommitted: true },
    })
  })

  it("any other failure is still the network card, reported", () => {
    asBrowser(UA.androidChrome)
    const failed = classify(new Error("boom"))
    expect(failed).toMatchObject({
      reported: true,
      refusal: { name: "error", message: copy.network },
    })
  })
})
