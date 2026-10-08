import { WINDOWS_HELLO } from "./passkeyProviders.js"

/**
 * Typed refusals from the passkey policy. Each carries a plain-language message the screens can
 * show as-is and a stable `name` the screens and tests can branch on.
 */

import { IOS_FLOOR_COPY, MAC_BROWSER_FLOOR_COPY } from "./refusalCopy.js"

/** Every refusal the passkey policy raises; a screen stays put and offers a retry on one. */
export class PasskeyPolicyError extends Error {}

/**
 * A ceremony that began on a security key was answered by something else. Sending this user to a
 * phone or a QR code would be wrong twice over: they are holding the right device, and on a phone
 * that route is refused anyway.
 */
export class SecurityKeyRequiredError extends PasskeyPolicyError {
  constructor() {
    super("Use the same security key you started with, and keep it in place until it finishes.")
    this.name = "SecurityKeyRequiredError"
  }
}

/**
 * A laptop ceremony answered from the laptop's own passkey instead of another device. A sign-up
 * whose answering provider is known names it, so the retry can get past that provider's offer; an
 * unnamed sign-up is told where to create the passkey, since it has none yet.
 */
export class PhoneRequiredError extends PasskeyPolicyError {
  readonly providerName?: string

  constructor(options: { providerName?: string; ceremony?: "create" | "sign-in" } = {}) {
    super(phoneRequiredMessage(options.providerName, options.ceremony ?? "sign-in"))
    this.providerName = options.providerName
    this.name = "PhoneRequiredError"
  }
}

function phoneRequiredMessage(
  providerName: string | undefined,
  ceremony: "create" | "sign-in",
): string {
  if (providerName === WINDOWS_HELLO) {
    return (
      "Windows Hello saved this passkey on this computer, but a sign-up here needs a phone over a " +
      "QR code, or a security key. When you try again and Windows offers to save it with Windows " +
      "Hello, choose another way to save it, then pick your phone or a security key."
    )
  }
  // "This device", not "this computer": a phone in desktop mode also counts as a laptop.
  if (providerName) {
    return (
      `${providerName} saved this passkey on this device, but a sign-up here needs a phone over a ` +
      `QR code, or a security key. When you try again, skip ${providerName}'s offer on this ` +
      "device. If a QR code appears, scan it with your phone. Or use your security key."
    )
  }
  if (ceremony === "create") {
    return (
      "To sign up on this computer, create your passkey on your phone or a security key. When you " +
      "try again, skip any offer from a password manager on this computer. If a QR code appears, " +
      "scan it with your phone. Or use your security key."
    )
  }
  return "Scan the QR code with the phone that holds your passkey, or plug in your security key."
}

/** A phone creation was handed to another phone over QR instead of answering on this device. */
export class LocalPasskeyRequiredError extends PasskeyPolicyError {
  constructor() {
    super(
      "Use this phone's own passkey, or a security key you can plug in or tap — not another phone.",
    )
    this.name = "LocalPasskeyRequiredError"
  }
}

/** The passkey is device-bound (or its backup flag could not be read), so no other device could ever open the wallet. */
export class DeviceBoundPasskeyError extends PasskeyPolicyError {
  constructor() {
    super(
      "This passkey can't be backed up, so it can't protect a wallet. Try again with a passkey " +
        "manager that syncs, such as iCloud Keychain or Google Password Manager.",
    )
    this.name = "DeviceBoundPasskeyError"
  }
}

/**
 * A security key answered but returned no key material, on either ceremony. Its own refusal rather
 * than `NoPrfError`, whose advice — pick a different provider in the sheet — means nothing to
 * someone holding a key. Known causes: iOS below 26.4, where a key's key material is unavailable
 * to the browser at all; a YubiKey Bio, which returns nothing; and an Android below the Play
 * Services floor. None is detectable before the credential is written.
 */
export class SecurityKeyNoPrfError extends PasskeyPolicyError {
  constructor() {
    super(
      "Your security key answered, but this device couldn't get the key material a wallet needs. " +
        "On iPhone this needs iOS 26.4 or later, and fingerprint keys aren't supported yet.",
    )
    this.name = "SecurityKeyNoPrfError"
  }
}

/**
 * A laptop creation the browser mislabelled came back without key material or a backup flag and
 * is not followed up (see the creation driver). Its own refusal: the provider is fine and the
 * phone was reached, so neither `NoPrfError` nor `PhoneUnreachableError` tells the truth.
 */
export class IncompleteCreationError extends PasskeyPolicyError {
  constructor() {
    super(
      "This browser didn't return everything the wallet needs from your phone. Update Safari or " +
        "use Chrome, then try again.",
    )
    this.name = "IncompleteCreationError"
  }
}

/** The provider returned no PRF output at creation nor on the follow-up assertion. */
export class NoPrfError extends PasskeyPolicyError {
  constructor() {
    super(
      "This passkey provider can't create a wallet key. Try again and pick a different passkey " +
        "provider in the browser's sheet.",
    )
    this.name = "NoPrfError"
  }
}

/**
 * The creation response reported a provider outside the measured set. `keyOfferable` names a
 * security key among the alternatives; every sheet the wallet opens can offer one.
 */
export class UnsupportedProviderError extends PasskeyPolicyError {
  readonly providerName?: string

  constructor(
    readonly kind: "manager" | "security-key",
    options: { providerName?: string; keyOfferable?: boolean } = {},
  ) {
    super(
      kind === "security-key"
        ? "Only YubiKey 5 series security keys can protect a wallet today. Try again with iCloud " +
            "Keychain, Google Password Manager, or 1Password."
        : `${options.providerName ?? "This passkey manager"} can't protect a wallet yet. Try ` +
            "again with iCloud Keychain, Google Password Manager, or 1Password" +
            `${options.keyOfferable ? ", or a YubiKey 5 security key" : ""}.`,
    )
    this.providerName = options.providerName
    this.name = "UnsupportedProviderError"
  }
}

/** The provider evaluated only one of the two salts, and not the one this route binds to. */
export class SingleSaltProviderError extends PasskeyPolicyError {
  constructor() {
    super(
      "This passkey provider returned only part of the key material the wallet needs. Try again " +
        "with a different passkey provider.",
    )
    this.name = "SingleSaltProviderError"
  }
}

/** Neither candidate key was named by any anchor: nothing was written. */
export class NoWalletForPasskeyError extends PasskeyPolicyError {
  constructor() {
    super(
      "No wallet was found for this passkey. Open zk.money on the device you signed up on, or " +
        "contact support.",
    )
    this.name = "NoWalletForPasskeyError"
  }
}

/** This browser is below the floor for creating a wallet passkey on a phone. */
export class PhoneUnreachableError extends PasskeyPolicyError {
  constructor() {
    super(MAC_BROWSER_FLOOR_COPY)
    this.name = "PhoneUnreachableError"
  }
}

/** This browser's record says the credential's key was rotated: its PRF never reproduces the account key. */
export class RotatedCredentialError extends PasskeyPolicyError {
  constructor() {
    super(
      "This passkey's key changed, so it no longer opens the wallet. Sign in with the passkey you " +
        "created the wallet with.",
    )
    this.name = "RotatedCredentialError"
  }
}

/** More than one candidate key was anchored: nothing was written. */
export class AmbiguousPasskeyError extends PasskeyPolicyError {
  constructor() {
    super("This passkey matches more than one wallet. Contact support before continuing.")
    this.name = "AmbiguousPasskeyError"
  }
}

/** The browser refused a request for a passkey that belongs to another zk.money site. */
export class RelatedOriginPasskeyError extends PasskeyPolicyError {
  constructor(cause?: unknown, options: { iosBelowFloor?: boolean } = {}) {
    super(
      options.iosBelowFloor
        ? IOS_FLOOR_COPY
        : "A browser extension, such as a password manager, may have blocked the passkey request on this site. " +
            "Turn off the extension's passkey option for this site, or use another browser, then try again. " +
            "If it still fails, contact support.",
      { cause },
    )
    this.name = "RelatedOriginPasskeyError"
  }
}

export function isPasskeyPolicyError(err: unknown): err is PasskeyPolicyError {
  return err instanceof PasskeyPolicyError
}

const EXTENSION_SCRIPT_RE = /(?:chrome|moz|safari-web)-extension:\/\//

/** A password manager's extension answered the request and failed with a plain `Error` of its own. */
export function isExtensionPasskeyError(err: unknown): boolean {
  try {
    const { name, message, stack } = err as { name?: unknown; message?: unknown; stack?: unknown }
    if (name !== "Error" || typeof stack !== "string") return false
    return EXTENSION_SCRIPT_RE.test(
      typeof message === "string" ? stack.replace(message, "") : stack,
    )
  } catch {
    return false
  }
}

/** The browser's passkey prompt was closed, or timed out, before it answered. Nothing was signed. */
export function isPasskeyCancelled(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === "NotAllowedError" || name === "AbortError"
}

/**
 * Errors thrown after the browser returned a credential: whatever the prompt saved is still there.
 * A side table rather than a property, since the browser's and an extension's errors are not ours.
 */
const written = new WeakSet<object>()

export function markPasskeyWritten<T>(err: T): T {
  if (typeof err === "object" && err !== null) written.add(err)
  return err
}

/** Whether a passkey was written before this error, or before the error it carries as `cause`. */
export function passkeyWritten(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  if (written.has(err)) return true
  const cause = (err as { cause?: unknown }).cause
  return typeof cause === "object" && cause !== null && written.has(cause)
}
