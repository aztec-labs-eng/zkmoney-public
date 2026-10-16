/** Refusal rows per policy error, and the functions that pick copy for a device. */
import { describe, expect, it } from "vitest"
import * as errors from "../src/policy/passkeyErrors.js"
import {
  IN_APP_BROWSER_REFUSAL,
  IN_APP_BROWSER_ROWS,
  PHONE_STEPS_COPY,
  REFUSAL_FALLBACK,
  REFUSAL_ROWS,
  UPDATE_CHROME_COPY,
  extensionLineFor,
  localNoteFor,
  refusalFor,
  repeatedRefusalLineFor,
  stepsCopyFor,
  supportedFor,
} from "../src/policy/refusalCopy.js"

const POLICY_ERRORS = [
  errors.PhoneRequiredError,
  errors.LocalPasskeyRequiredError,
  errors.DeviceBoundPasskeyError,
  errors.IncompleteCreationError,
  errors.NoPrfError,
  errors.SingleSaltProviderError,
  errors.NoWalletForPasskeyError,
  errors.PhoneUnreachableError,
  errors.RotatedCredentialError,
  errors.AmbiguousPasskeyError,
]

describe("refusalFor", () => {
  it("names every policy error with its own title", () => {
    const titles = new Set<string>()
    for (const Ctor of POLICY_ERRORS) {
      const row = refusalFor(new Ctor())
      expect(row.title).not.toBe(refusalFor({ name: "SomethingElse" }).title)
      titles.add(row.title)
    }
    expect(refusalFor(new errors.UnsupportedProviderError("manager")).title).toContain(
      "isn't supported",
    )
    // NoPrfError and SingleSaltProviderError share one title; every other error has its own.
    expect(titles.size).toBe(POLICY_ERRORS.length - 1)
  })

  it("has a row for every policy error name and nothing else", () => {
    const names = [
      ...POLICY_ERRORS.map((Ctor) => new Ctor().name),
      new errors.UnsupportedProviderError("manager").name,
      new errors.LaptopPasskeyRefusedError("apple").name,
      new errors.SecurityKeyNoPrfError().name,
      new errors.SecurityKeyRequiredError().name,
      new errors.RelatedOriginPasskeyError().name,
    ]
    expect(Object.keys(REFUSAL_ROWS).sort()).toEqual(names.sort())
  })

  it("offers no retry where another attempt cannot help", () => {
    expect(refusalFor(new errors.RotatedCredentialError()).retry).toBe(false)
    expect(refusalFor(new errors.AmbiguousPasskeyError()).retry).toBe(false)
    // The browser's version cannot change between attempts.
    expect(refusalFor(new errors.PhoneUnreachableError()).retry).toBe(false)
    expect(refusalFor(new errors.PhoneRequiredError()).retry).toBe(true)
    expect(refusalFor({ name: "error" })).toBe(REFUSAL_FALLBACK)
  })

  it("takes a consumer's rows for its own errors and lets them override shared ones", () => {
    const mismatch = { title: "This passkey opens a different account", retry: true }
    const noAccount = {
      title: "No campaign account for this passkey",
      retry: true,
      message: "Create an account first.",
    }
    const extra = { PasskeyMismatchError: mismatch, NoWalletForPasskeyError: noAccount }
    expect(refusalFor({ name: "PasskeyMismatchError" }, extra)).toBe(mismatch)
    expect(refusalFor(new errors.NoWalletForPasskeyError(), extra)).toBe(noAccount)
    expect(refusalFor(new errors.PhoneRequiredError(), extra)).toBe(REFUSAL_ROWS.PhoneRequiredError)
    expect(refusalFor({ name: "PasskeyMismatchError" })).toBe(REFUSAL_FALLBACK)
  })

  it("sends a browser that can't run passkeys to the phone's browser, retrying only where it can help", () => {
    const unsupported = refusalFor({ name: "NotSupportedError" }, IN_APP_BROWSER_ROWS)
    const inApp = refusalFor({ name: IN_APP_BROWSER_REFUSAL }, IN_APP_BROWSER_ROWS)
    expect(unsupported).toMatchObject({ retry: true, openInBrowser: true })
    expect(unsupported.message).toContain("open it in your phone's browser")
    expect(inApp).toEqual({ ...unsupported, retry: false })
    // Neither is a policy error, so the shared rows never answer for them.
    expect(refusalFor({ name: "NotSupportedError" })).toBe(REFUSAL_FALLBACK)
  })
})

describe("copy selection", () => {
  // The rows as `laptopCreationFor` builds them.
  const macChrome = {
    local: true,
    os: "macos",
    row: "macChrome",
    managers: ["apple", "gpm"],
    withdrawn: [],
  } as const
  const edge = { ...macChrome, row: "macEdgeBrave", managers: ["apple"] } as const
  const windows = {
    local: true,
    os: "windows",
    row: "windowsChrome",
    managers: ["gpm", "1password"],
    withdrawn: [],
  } as const
  const windowsEdge = { ...windows, row: "windowsEdgeBrave", managers: ["1password"] } as const
  const safari = {
    local: true,
    os: "macos",
    row: "macSafari",
    managers: ["1password"],
    withdrawn: [],
    chromeTip: "apple",
  } as const

  it("picks the steps from what the browser said about reaching a phone", () => {
    expect(stepsCopyFor("no-hybrid")).toBe(PHONE_STEPS_COPY.noPhone)
    for (const reach of ["ok", "unknown", "below-floor"] as const) {
      expect(stepsCopyFor(reach)).toBe(PHONE_STEPS_COPY)
    }
    // A laptop that may not create on its own manager reads today's steps whatever it says.
    for (const creation of [
      { local: false, chromeTip: "apple" },
      { local: false, chromeTip: "gpm" },
      { local: false, chromeTip: false },
    ] as const) {
      expect(stepsCopyFor("ok", creation)).toBe(PHONE_STEPS_COPY)
      expect(stepsCopyFor("no-hybrid", creation)).toBe(PHONE_STEPS_COPY.noPhone)
    }
  })

  it("offers its own manager first, then the phone, then the key, and drops the phone where none can be reached", () => {
    expect(stepsCopyFor("ok", macChrome).routes.map((r) => r.hint)).toEqual([
      "client-device",
      "hybrid",
      "security-key",
    ])
    expect(stepsCopyFor("no-hybrid", macChrome).routes.map((r) => r.hint)).toEqual([
      "client-device",
      "security-key",
    ])
  })

  it("words the update line in parts that join to one sentence", () => {
    const { maybeBefore, maybeLink, maybeAfter } = UPDATE_CHROME_COPY
    expect(Object.keys(UPDATE_CHROME_COPY)).toEqual(["maybeBefore", "maybeLink", "maybeAfter"])
    expect(maybeBefore + maybeLink + maybeAfter).toBe(
      "If you're already in Chrome, update it from the Play Store and open this page again, or use another browser.",
    )
  })

  it("tells a user without an extension where 1Password answers, by the row's system", () => {
    // On a Mac either surface returns key material: a word only where 1Password is alone.
    expect(localNoteFor(safari)).toBe(PHONE_STEPS_COPY.local.pickOnePassword)
    expect(localNoteFor({ ...macChrome, managers: ["apple", "gpm", "1password"] })).toBeUndefined()
    expect(localNoteFor(macChrome)).toBeUndefined()
    // On Windows and Linux only the extension does, so every row that lists 1Password says so.
    for (const creation of [windows, windowsEdge, { ...windows, os: "linux" } as const]) {
      expect(localNoteFor(creation)).toBe(PHONE_STEPS_COPY.local.installExtension)
    }
    expect(localNoteFor({ ...windows, managers: ["gpm"] })).toBeUndefined()
  })

  it("names 1Password in the pop-up line only on rows that list it", () => {
    for (const creation of [windows, windowsEdge, safari]) {
      expect(extensionLineFor(creation)).toMatch(/1Password/)
    }
    for (const creation of [macChrome, edge, { ...windows, managers: ["gpm"] } as const]) {
      expect(extensionLineFor(creation)).not.toMatch(/1Password/)
    }
  })

  it("after repeated refusals points elsewhere, except where 1Password is the only manager", () => {
    expect(repeatedRefusalLineFor(windows)).toBeDefined()
    expect(repeatedRefusalLineFor(macChrome)).toBeDefined()
    expect(repeatedRefusalLineFor(windowsEdge)).toBeUndefined()
  })

  it("lists only the row's managers and the key as supported, and leaves the phone variant alone", () => {
    expect(supportedFor(windows).providers).toEqual([
      "Google Password Manager",
      "1Password",
      "YubiKey 5 security key",
    ])
    expect(supportedFor(windowsEdge).providers).toEqual(["1Password", "YubiKey 5 security key"])
    expect(supportedFor(edge).providers).toEqual(["iCloud Keychain", "YubiKey 5 security key"])
    expect(
      supportedFor({ ...macChrome, managers: ["apple"], withdrawn: ["gpm"] }).providers,
    ).not.toContain("Google Password Manager")
    expect(supportedFor({ local: false, chromeTip: "apple" })).toBe(PHONE_STEPS_COPY.supported)
    expect(supportedFor()).toBe(PHONE_STEPS_COPY.supported)
  })
})

describe("refusal messages", () => {
  it("a named provider keeps its own advice on a sign-up; an unnamed sign-up gets its own", () => {
    const signUp = new errors.PhoneRequiredError({ ceremony: "create" })
    expect(refusalFor(signUp)).toBe(REFUSAL_ROWS.PhoneRequiredError)
    expect(signUp.message).not.toBe(new errors.PhoneRequiredError().message)
    expect(
      new errors.PhoneRequiredError({ ceremony: "create", providerName: "Bitwarden" }).message,
    ).toBe(new errors.PhoneRequiredError({ providerName: "Bitwarden" }).message)
    expect(new errors.PhoneRequiredError({ providerName: "1Password" }).providerName).toBe(
      "1Password",
    )
  })

  it("mentions a security key only when the caller can offer one", () => {
    const offer = new errors.UnsupportedProviderError("manager", { keyOfferable: true })
    const noKey = new errors.UnsupportedProviderError("manager", { keyOfferable: false })
    expect(offer.message).toMatch(/security key/)
    expect(noKey.message).not.toMatch(/security key/)
  })
})
