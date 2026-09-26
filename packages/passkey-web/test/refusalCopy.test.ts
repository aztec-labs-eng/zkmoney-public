/** One refusal row per policy error, the two that offer no retry, and a consumer's own rows. */
import { describe, expect, it } from "vitest"
import * as errors from "../src/policy/passkeyErrors.js"
import {
  IOS_FLOOR_COPY,
  MISMATCH_COPY,
  PHONE_STEPS_COPY,
  REFUSAL_FALLBACK,
  REFUSAL_ROWS,
  SIGN_IN_SHEET_COPY,
  refusalFor,
  stepsCopyFor,
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
      new errors.SecurityKeyNoPrfError().name,
      new errors.SecurityKeyRequiredError().name,
      new errors.RelatedOriginPasskeyError("auth.zk.money").name,
    ]
    expect(Object.keys(REFUSAL_ROWS).sort()).toEqual(names.sort())
  })

  it("offers no retry where another attempt cannot help", () => {
    expect(refusalFor(new errors.RotatedCredentialError()).retry).toBe(false)
    expect(refusalFor(new errors.AmbiguousPasskeyError()).retry).toBe(false)
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
})

describe("copy", () => {
  it("carries the two creation steps, a caption and a cancel, naming both routes", () => {
    expect(PHONE_STEPS_COPY.caption).toContain("passkey")
    expect(PHONE_STEPS_COPY.cancelLabel).toBe("Cancel")
    expect(PHONE_STEPS_COPY.createSteps).toHaveLength(2)
    // A laptop cannot tell where the passkey will live, so neither route may be the only one offered.
    const shown = [...PHONE_STEPS_COPY.createSteps, PHONE_STEPS_COPY.caption].join(" ")
    expect(shown).toMatch(/phone/i)
    expect(shown).toMatch(/security key/i)
  })

  it("never asks a user who is signing up for the passkey they signed up with", () => {
    const { createSteps, noPhone } = PHONE_STEPS_COPY
    expect([...createSteps, ...noPhone.createSteps].join(" ")).not.toMatch(
      /signed up with|holds your passkey/i,
    )
  })

  it("offers one button per route a laptop may take, each with the hint that opens it", () => {
    expect(PHONE_STEPS_COPY.routes.map((route) => route.hint)).toEqual(["hybrid", "security-key"])
    expect(PHONE_STEPS_COPY.routes[0]!.label).toMatch(/QR/i)
    expect(PHONE_STEPS_COPY.routes[1]!.label).toMatch(/security key/i)
    // The browser this cannot reach a phone has one route, so it gets one button.
    expect(PHONE_STEPS_COPY.noPhone.routes.map((route) => route.hint)).toEqual(["security-key"])
  })

  it("the sign-in sheet names one action and promises no device", () => {
    expect(SIGN_IN_SHEET_COPY.title).toBe("Sign in")
    expect(SIGN_IN_SHEET_COPY.continueLabel).toBe("Continue")
    expect(SIGN_IN_SHEET_COPY.cancelLabel).toBe("Cancel")
    // The browser's chooser lists whatever holds the passkey, so the sheet must not steer to one.
    expect(SIGN_IN_SHEET_COPY.subtitle).toMatch(/passkey/i)
    expect(SIGN_IN_SHEET_COPY.subtitle).not.toMatch(/phone|security key|this computer|QR/i)
  })

  it("the mismatch verdicts: the certain wrong key has no retry and points at Show passkeys; the weaker one keeps retry", () => {
    // The same copy would answer a retry; another device is picked in the browser's full chooser.
    expect(MISMATCH_COPY["wrong-key"].retry).toBe(false)
    expect(MISMATCH_COPY["wrong-key"].message).toMatch(/wrong key/i)
    expect(MISMATCH_COPY["wrong-key"].message).toMatch(/Show passkeys/)
    // The phone route is the QR code; the card says so, since the prompt's own labels do not.
    expect(MISMATCH_COPY["wrong-key"].message).toMatch(/phone \(scan the QR code with it\)/i)
    expect(MISMATCH_COPY["wrong-key"].message).toMatch(/security key/i)
    expect(MISMATCH_COPY["not-reproduced"].retry).toBe(true)
  })

  it("names the iOS floor", () => {
    expect(IOS_FLOOR_COPY).toContain("18.4")
  })

  it("offers security-key steps where no phone can be reached", () => {
    const { noPhone } = PHONE_STEPS_COPY
    expect(noPhone.createSteps).toHaveLength(2)
    // What the user is told to do may not name a route this browser lacks; the caption may still
    // explain why the phone is out.
    const todo = [
      noPhone.hero.title,
      ...noPhone.createSteps,
      ...noPhone.routes.map((route) => route.label),
    ].join(" ")
    expect(todo).toMatch(/security key/i)
    expect(todo).not.toMatch(/scan|QR|phone/i)
    expect(noPhone.caption).toMatch(/only copy/i)
    // Says what to do when the passkey is on a phone this computer cannot reach, rather than
    // claiming a key holds this wallet's key when it may not.
    expect(noPhone.caption).toMatch(/if a phone holds your passkey/i)
    expect(noPhone.hero.glyph).toBe("security-key")
  })

  it("names the device to fetch above the steps, for readers who skim", () => {
    expect(PHONE_STEPS_COPY.hero.glyph).toBe("phone")
    // The hero is the loudest line on the sheet, so it may not name one route when both are open.
    expect(PHONE_STEPS_COPY.hero.title).toMatch(/phone/i)
    expect(PHONE_STEPS_COPY.hero.title).toMatch(/security key/i)
  })

  it("picks the steps from what the browser said about reaching a phone", () => {
    expect(stepsCopyFor("no-hybrid")).toBe(PHONE_STEPS_COPY.noPhone)
    for (const reach of ["ok", "unknown", "below-floor"] as const) {
      expect(stepsCopyFor(reach)).toBe(PHONE_STEPS_COPY)
    }
  })

  it("names both routes when the wrong device answered", () => {
    expect(REFUSAL_ROWS.PhoneRequiredError!.title).toContain("security key")
    expect(new errors.PhoneRequiredError().message).toMatch(/security key/)
  })

  it("tells an unsupported key from an unsupported manager", () => {
    // The orphan a key just wrote lives on the key, so the two refusals cannot share advice.
    const key = new errors.UnsupportedProviderError("security-key")
    expect(key.message).toMatch(/YubiKey 5/)
    expect(key.message).toMatch(/FIDO2/)
    const manager = new errors.UnsupportedProviderError("manager", {
      providerName: "Bitwarden",
      keyOfferable: true,
    })
    expect(manager.message).toMatch(/^Bitwarden/)
    expect(manager.message).toMatch(/security key/)
    expect(manager.providerName).toBe("Bitwarden")
    // A caller that says a key cannot be offered gets no mention of one.
    const noKey = new errors.UnsupportedProviderError("manager", { keyOfferable: false })
    expect(noKey.message).toMatch(/^This passkey manager/)
    expect(noKey.message).not.toMatch(/security key/)
  })
})
