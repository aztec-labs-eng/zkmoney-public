/** One refusal row per policy error, the two that offer no retry, and a consumer's own rows. */
import { describe, expect, it } from "vitest"
import * as errors from "../src/policy/passkeyErrors.js"
import { MAC_FIREFOX_FLOOR, MAC_SAFARI_FLOOR } from "../src/policy/passkeyCapabilities.js"
import {
  IN_APP_BROWSER_REFUSAL,
  IN_APP_BROWSER_ROWS,
  IN_APP_UP_FRONT_COPY,
  IOS_FLOOR_COPY,
  LEFTOVER_PASSKEY_COPY,
  MAC_BROWSER_FLOOR_COPY,
  MISMATCH_COPY,
  PHONE_HELP_COPY,
  PHONE_STEPS_COPY,
  REFUSAL_FALLBACK,
  REFUSAL_ROWS,
  SIGN_IN_SHEET_COPY,
  refusalFor,
  stepsCopyFor,
} from "../src/policy/refusalCopy.js"
import { IOS_PASSKEY_FLOOR } from "../src/policy/userAgentInfo.js"

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

  it("offers one control per route a laptop may take: the button's hint opens the prompt, the link opens the key variant", () => {
    expect(PHONE_STEPS_COPY.routes).toEqual([
      { hint: "hybrid", label: "Show QR Code" },
      { hint: "security-key", label: "Have a security key? Use it instead" },
    ])
    // The browser that cannot reach a phone has one route, so it gets one button.
    expect(PHONE_STEPS_COPY.noPhone.routes).toEqual([
      { hint: "security-key", label: "Create account with my security key" },
    ])
  })

  it("says what to do with the QR code, and why the phone, before the prompt opens", () => {
    expect(PHONE_STEPS_COPY.title).toBe("Scan QR code to save the key on your phone")
    expect(PHONE_STEPS_COPY.subtitle).toBe(
      "This creates your account. One-time setup, about 20 seconds.",
    )
    expect(PHONE_STEPS_COPY.why).toEqual({
      title: "Why use the phone?",
      body: "A passkey saved on your phone can sync across your devices.",
      link: "How passkeys work on zk.money",
    })
    const { noPhone } = PHONE_STEPS_COPY
    expect(noPhone.title).toBe("Create account with your security key")
    expect(noPhone.subtitle).toBe("One-time setup. About 20 seconds.")
    expect(noPhone.note).toBe(
      "Your security key keeps the only copy of your passkey. A second key can't be added as a " +
        "backup, and there is no account recovery: lose the key, lose the wallet.",
    )
    expect(noPhone.models).toBe(
      "YubiKey 5 series keys are supported today (tested with a YubiKey 5 NFC). Another key may " +
        "fail only after it has saved a passkey, which you'd then need to remove yourself.",
    )
    // Nothing on the key-only sheet names a route this browser lacks, or promises a backup. The
    // way back to the phone is offered only where a phone route exists, so it is not in this list.
    const shown = [
      noPhone.title,
      noPhone.subtitle,
      noPhone.note,
      noPhone.models,
      noPhone.routes[0]!.label,
    ]
    expect(shown.join(" ")).not.toMatch(/scan|QR|phone|backed up/i)
    expect(noPhone.back).toBe("Use my phone instead")
  })

  it("tells every sign-up that the passkey is the only way in, and the key sheet what a key means", () => {
    const { loss } = PHONE_STEPS_COPY
    expect(loss.label).toBe("Lose your passkey, lose the wallet.")
    expect(loss.line).toBe("There is no account recovery. Lose your passkey, lose the wallet.")
    expect(loss.title).toMatch(/only way in/)
    // The tooltip says what the one sentence cannot: no recovery, the sync is the backup, and a
    // second key is not one.
    const tip = loss.body.join(" ")
    expect(tip).toMatch(/no account recovery/)
    expect(tip).toMatch(/sync.*backup/)
    expect(tip).toMatch(/second key/i)
    expect(tip).toMatch(/lose the key, lose the wallet/)
    const { note, models } = PHONE_STEPS_COPY.noPhone
    expect(note).toMatch(/only copy/)
    expect(note).toMatch(/second key/i)
    expect(note).toMatch(/lose the key/i)
    // The allowlist admits the whole Yubico family and an unreported id, so another key is not
    // always refused; the line names the tested model and says "may".
    expect(models).toMatch(/YubiKey 5/)
    expect(models).toMatch(/may fail/)
    expect(models).toMatch(/remove/)
    expect(models).not.toMatch(/\bonly YubiKey/i)
  })

  it("lists the passkeys a creation admits, and names what it refuses", () => {
    const { supported } = PHONE_STEPS_COPY
    expect(supported.label).toBe("Supported passkeys")
    expect(supported.providers).toEqual([
      "iCloud Keychain (Apple Passwords)",
      "Google Password Manager",
      "1Password",
      "YubiKey 5 security key",
    ])
    expect(supported.refused).toMatch(/Bitwarden/)
    expect(supported.refused).toMatch(/Windows Hello/)
    // The key-only sheet names the one kind of key that works, and no manager it cannot use.
    expect(PHONE_STEPS_COPY.noPhone.models).toMatch(/YubiKey 5/)
    expect(PHONE_STEPS_COPY.noPhone.models).not.toMatch(/manager|iCloud|Google|1Password/i)
  })

  it("tells a laptop with a password manager's extension not to save there, on this computer only", () => {
    const { extension } = PHONE_STEPS_COPY
    expect(extension).toBe(
      "If a password manager pops up on this computer, don't save the passkey there. Choose " +
        "another device or hardware key if it offers one.",
    )
    // A password manager on the phone is accepted, so the line names this computer's.
    expect(extension).toMatch(/password manager.*this computer/)
    // "If": a manager that leaves the request to the browser shows nothing.
    expect(extension).toMatch(/^If /)
    // Closing a manager's window can end the whole sign-up.
    expect(extension).not.toMatch(/close/i)
    expect(PHONE_HELP_COPY.extensionTitle).not.toMatch(/phone|bluetooth/i)
  })

  it("the card's row says where not to save, and its tooltip names what offers to", () => {
    const { label, extension, refused } = PHONE_STEPS_COPY.thisComputer
    expect(label).toBe("Don't save the passkey on this computer")
    expect(extension[0]).toMatch(/Bitwarden/)
    // A password manager on the phone is accepted, so every one named is this computer's.
    for (const line of extension) {
      if (/password manager/i.test(line)) expect(line).toMatch(/this computer/)
    }
    // Closing a manager's window can end the whole sign-up, so the tooltip never asks for it.
    expect(extension.join(" ")).not.toMatch(/\bclose (it|the pop-up)\b/i)
    expect(refused).toMatch(/this computer/)
  })

  it("the up-front in-app card names the problem and names no step", () => {
    const { title, line } = IN_APP_UP_FRONT_COPY
    expect(title).toBe("Passkeys don't work in this app's browser")
    expect(line).toBe("zk.money uses a passkey to create and open your account.")
    // The way-out block under the title says what to do; a title that said "open" would be wrong
    // where there is nothing to open.
    expect(title).not.toMatch(/open|tap|copy/i)
  })

  it("the laptop help card says what to check, and offers the key the steps sheet offers", () => {
    const { quick, slow, noPhone, windows, securityKey, link, question } = PHONE_HELP_COPY
    expect(quick.title).toBe("Create your passkey with your phone")
    expect(slow.title).toBe("Your phone didn't connect")
    // The laptop received nothing; whether the phone saved a passkey it cannot know.
    expect(slow.body).toMatch(/^Check that Bluetooth/)
    expect(slow.body).not.toMatch(/Nothing was saved/)
    expect(quick.body).not.toMatch(/Nothing was saved/)
    expect(quick.body).not.toMatch(/Bluetooth/)
    expect(noPhone.body).not.toMatch(/Bluetooth|QR/)
    expect(windows).toMatch(/Windows Hello/)
    expect(securityKey).toBe(PHONE_STEPS_COPY.routes.find((r) => r.hint === "security-key")!.label)
    expect(link.inviteKept).toBe("Your invite is kept.")
    expect(question.answers.map((a) => a.value)).toEqual([
      "no_phone",
      "no_bluetooth",
      "windows_hello",
      "phone_failed",
      "other",
    ])
    expect(question.answers.filter((a) => "windowsOnly" in a).map((a) => a.value)).toEqual([
      "windows_hello",
    ])
    // A drop-down's rows are read in one glance; none opens with "I" or "My".
    for (const { label } of question.answers) expect(label).not.toMatch(/^(I|My)\b/)
    expect(question.placeholder).toMatch(/optional/)
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

  it("names the iOS floor and the two ways past it, and blames nothing else", () => {
    expect(IOS_FLOOR_COPY).toContain(`iOS ${IOS_PASSKEY_FLOOR} or later`)
    expect(IOS_FLOOR_COPY).toContain("Update iOS")
    expect(IOS_FLOOR_COPY).toContain("another device")
    expect(IOS_FLOOR_COPY).not.toMatch(/bug|extension|another browser/i)
  })

  it("names the Mac browser floors and the ways past them", () => {
    const message = new errors.PhoneUnreachableError().message
    expect(message).toBe(MAC_BROWSER_FLOOR_COPY)
    expect(message).toContain(`Safari ${MAC_SAFARI_FLOOR} or later`)
    expect(message).toContain(`Firefox ${MAC_FIREFOX_FLOOR} or later`)
    expect(message).toContain("Chrome")
    expect(message).toContain("Software Update")
    expect(REFUSAL_ROWS.PhoneUnreachableError!.title).toContain("Chrome")
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
    const unnamed = new errors.PhoneRequiredError()
    expect(unnamed.message).toBe(
      "Scan the QR code with the phone that holds your passkey, or plug in your security key.",
    )
    expect(unnamed.providerName).toBeUndefined()
  })

  it("tells an unnamed laptop sign-up where to create its passkey, since it has none yet", () => {
    const signUp = new errors.PhoneRequiredError({ ceremony: "create" })
    expect(signUp.name).toBe("PhoneRequiredError")
    expect(refusalFor(signUp)).toBe(REFUSAL_ROWS.PhoneRequiredError)
    expect(signUp.message).toBe(
      "To sign up on this computer, create your passkey on your phone or a security key. When you " +
        "try again, skip any offer from a password manager on this computer. If a QR code appears, " +
        "scan it with your phone. Or use your security key.",
    )
    // A password manager on the phone is accepted, so every one named is this computer's.
    for (const sentence of signUp.message.split(/(?<=\.) /)) {
      if (/password manager/.test(sentence)) expect(sentence).toMatch(/this computer/)
    }
    // A named provider keeps its own advice on a sign-up.
    expect(
      new errors.PhoneRequiredError({ ceremony: "create", providerName: "Bitwarden" }).message,
    ).toBe(new errors.PhoneRequiredError({ providerName: "Bitwarden" }).message)
  })

  it("tells a laptop sign-up which provider answered and how to get past it next time", () => {
    // 1Password is accepted on a phone, so the skip must be tied to this device and this attempt.
    const named = new errors.PhoneRequiredError({ providerName: "1Password" })
    expect(named.name).toBe("PhoneRequiredError")
    expect(named.providerName).toBe("1Password")
    expect(named.message).toMatch(/^1Password saved this passkey on this device/)
    expect(named.message).toContain(
      "a sign-up here needs a phone over a QR code, or a security key",
    )
    expect(named.message).toContain("When you try again, skip 1Password's offer on this device.")
    expect(named.message).toContain("If a QR code appears, scan it with your phone.")
    expect(named.message).not.toMatch(
      /must be on your phone|holds your passkey|Select|this computer/,
    )
    expect(refusalFor(named)).toBe(REFUSAL_ROWS.PhoneRequiredError)
  })

  it("points a Windows Hello answer at Windows' own prompt", () => {
    const windows = new errors.PhoneRequiredError({ providerName: "Windows Hello" })
    expect(windows.message).toMatch(/^Windows Hello saved this passkey on this computer/)
    expect(windows.message).toContain("choose another way to save it")
    expect(windows.message).toMatch(/phone/)
    expect(windows.message).toMatch(/security key/)
    expect(windows.message).not.toMatch(/holds your passkey|Select|skip/)
  })

  it("ties every skip or refusal in the named copy to this device", () => {
    for (const providerName of ["Bitwarden", "Windows Hello", "Google Password Manager"]) {
      const sentences = new errors.PhoneRequiredError({ providerName }).message.split(/(?<=\.) /)
      for (const sentence of sentences.filter((s) => /\bskip\b|\bnot\b/.test(s))) {
        expect(sentence).toMatch(/this device|this computer/)
      }
    }
  })

  it("tells an unsupported key from an unsupported manager", () => {
    // A key holder is told which keys work, a manager user which managers.
    const key = new errors.UnsupportedProviderError("security-key")
    expect(key.message).toMatch(/YubiKey 5/)
    expect(key.message).toMatch(/iCloud Keychain, Google Password Manager, or 1Password/)
    const manager = new errors.UnsupportedProviderError("manager", {
      providerName: "Bitwarden",
      keyOfferable: true,
    })
    expect(manager.message).toMatch(/^Bitwarden/)
    expect(manager.message).toMatch(/iCloud Keychain, Google Password Manager, or 1Password/)
    expect(manager.message).toMatch(/security key/)
    expect(manager.providerName).toBe("Bitwarden")
    // A caller that says a key cannot be offered gets no mention of one.
    const noKey = new errors.UnsupportedProviderError("manager", { keyOfferable: false })
    expect(noKey.message).toMatch(/^This passkey manager/)
    expect(noKey.message).not.toMatch(/security key/)
  })

  it("explains deletion nowhere in a message: the card's cleanup line does that", () => {
    const messages = [
      new errors.UnsupportedProviderError("security-key"),
      new errors.UnsupportedProviderError("manager", { providerName: "Bitwarden" }),
      new errors.SecurityKeyNoPrfError(),
      new errors.IncompleteCreationError(),
      new errors.LocalPasskeyRequiredError(),
    ].map((e) => e.message)
    for (const message of messages) {
      expect(message).not.toMatch(/delete|removed|YubiKey Manager|FIDO2|just made/i)
    }
    expect(new errors.LocalPasskeyRequiredError().message).toMatch(/this phone's own passkey/)
    expect(new errors.LocalPasskeyRequiredError().message).toMatch(/security key/)
  })

  it("the cleanup line names the fact, the link, and a bare anchor", () => {
    expect(LEFTOVER_PASSKEY_COPY).toEqual({
      line: "A passkey may have been saved.",
      link: "How to delete it",
      anchor: "leftover-passkey",
    })
    expect(LEFTOVER_PASSKEY_COPY.anchor).not.toMatch(/[#/]/)
  })
})
