/**
 * Typed refusals from the passkey policy. Each carries a plain-language message the screens can
 * show as-is and a stable `name` the screens and tests can branch on.
 */

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

/** A laptop ceremony answered from the laptop's own passkey instead of another device. */
export class PhoneRequiredError extends PasskeyPolicyError {
  constructor() {
    super("Scan the QR code with the phone that holds your passkey, or plug in your security key.")
    this.name = "PhoneRequiredError"
  }
}

/** A phone creation was handed to another phone over QR instead of answering on this device. */
export class LocalPasskeyRequiredError extends PasskeyPolicyError {
  constructor() {
    super(
      "Use this phone's own passkey, or a security key you can plug in or tap — not another " +
        "phone. Whatever answered may have made a passkey: delete it on that phone, or remove " +
        "it from a security key with YubiKey Manager or another FIDO2 tool.",
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
        "On iPhone this needs iOS 26.4 or later, and fingerprint keys aren't supported yet. The " +
        "passkey it just made can be removed with YubiKey Manager or another FIDO2 tool.",
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
        "use Chrome, then try again. The passkey it left in the passkey manager you chose on your " +
        "phone can be deleted.",
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
        ? "Only YubiKey 5 series security keys can protect a wallet today. The passkey it just " +
            "made can be removed with YubiKey Manager or another FIDO2 tool, then try again " +
            "with iCloud Keychain, Google Password Manager, or 1Password."
        : `${options.providerName ?? "This passkey manager"} can't protect a wallet yet. Delete ` +
            "the passkey it just made, then try again with iCloud Keychain, Google Password " +
            `Manager, or 1Password${options.keyOfferable ? ", or a YubiKey 5 security key" : ""}.`,
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
    super(
      "This browser can't create a wallet passkey with your phone. Update it, or open zk.money in " +
        "a current version of Chrome or Safari.",
    )
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

export class RelatedOriginPasskeyError extends PasskeyPolicyError {
  constructor(rpId: string) {
    super(
      `This browser could not authorize passkeys for ${rpId} on this site. Update your browser and try again. If it still fails, contact support.`,
    )
    this.name = "RelatedOriginPasskeyError"
  }
}

export function isPasskeyPolicyError(err: unknown): err is PasskeyPolicyError {
  return err instanceof PasskeyPolicyError
}

/** The browser's passkey prompt was closed, or timed out, before it answered. Nothing was signed. */
export function isPasskeyCancelled(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === "NotAllowedError" || name === "AbortError"
}
