/** Refusal rows per policy error, and the functions that pick copy for a device. */
import { describe, expect, it } from "vitest"
import * as errors from "../src/policy/passkeyErrors.js"
import {
  APPLE_FLOOR_COPY,
  IN_APP_BROWSER_REFUSAL,
  IN_APP_BROWSER_ROWS,
  MAC_UPDATE_COPY,
  MAC_WRONG_KEY_COPY,
  MISMATCH_COPY,
  PHONE_STEPS_COPY,
  REFUSAL_FALLBACK,
  REFUSAL_ROWS,
  UPDATE_CHROME_COPY,
  macUpdateAdviceFor,
  refusalFor,
  stepsCopyFor,
} from "../src/policy/refusalCopy.js"
import { parseUserAgent } from "../src/policy/userAgentInfo.js"

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
  it("picks the steps from what the browser said about reaching a phone", () => {
    expect(stepsCopyFor("no-hybrid")).toBe(PHONE_STEPS_COPY.noPhone)
    for (const reach of ["ok", "unknown", "below-floor"] as const) {
      expect(stepsCopyFor(reach)).toBe(PHONE_STEPS_COPY)
    }
  })

  it("words the update line in parts that join to one sentence", () => {
    const { maybeBefore, maybeLink, maybeAfter } = UPDATE_CHROME_COPY
    expect(Object.keys(UPDATE_CHROME_COPY)).toEqual(["maybeBefore", "maybeLink", "maybeAfter"])
    expect(maybeBefore + maybeLink + maybeAfter).toBe(
      "If you're already in Chrome, update it from the Play Store and open this page again, or use another browser.",
    )
  })
})

describe("macUpdateAdviceFor", () => {
  const hinted = (platform: string, platformVersion: string) =>
    parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/155.0.0.0 Safari/537.36",
      userAgentData: { platform, platformVersion },
    })

  it("words the line by what the browser reports, and gives none past the floors", () => {
    const safari = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
        "Version/26.4 Safari/605.1.15",
    })
    expect(macUpdateAdviceFor(safari)).toBe("unknown")
    expect(macUpdateAdviceFor(hinted("macOS", "26.2.0"))).toBe("below")
    expect(macUpdateAdviceFor(hinted("macOS", "14.6"))).toBe("below")
    expect(macUpdateAdviceFor(hinted("macOS", "26.4.1"))).toBeUndefined()
    expect(macUpdateAdviceFor(hinted("macOS", "15.7.5"))).toBeUndefined()
    const windows = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/155.0.0.0 Safari/537.36",
    })
    expect(macUpdateAdviceFor(windows)).toBeUndefined()
  })

  it("never promises", () => {
    for (const line of Object.values(MAC_UPDATE_COPY)) {
      expect(line).toContain("worth a try")
      expect(line).not.toMatch(/\bwill\b|\bfixes\b/)
    }
  })
})

describe("the wrong-key card", () => {
  it("on a Mac sends the user to the phone and says how long the browser keeps them signed in", () => {
    expect(MAC_WRONG_KEY_COPY.retry).toBe(false)
    expect(MAC_WRONG_KEY_COPY.title).toBe(MISMATCH_COPY["wrong-key"].title)
    expect(MAC_WRONG_KEY_COPY.message).toContain("Use your phone")
    expect(MAC_WRONG_KEY_COPY.message).toContain(
      "until you sign out or this browser clears its data",
    )
    expect(MAC_WRONG_KEY_COPY.message).not.toMatch(/\d+\.\d+/)
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

describe("the sign-up refusal copy", () => {
  it("names no macOS point release", () => {
    expect(JSON.stringify({ PHONE_STEPS_COPY, APPLE_FLOOR_COPY })).not.toMatch(/15\.7\.5|26\.4\.1/)
  })
})
