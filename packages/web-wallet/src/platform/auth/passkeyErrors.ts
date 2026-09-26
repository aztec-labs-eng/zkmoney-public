/**
 * Typed refusals from the passkey policy. Each carries a plain-language message the screens can
 * show as-is and a stable `name` the screens and tests can branch on.
 */

/** Every refusal the passkey policy raises; a screen stays put and offers a retry on one. */
export class PasskeyPolicyError extends Error {}

/** A laptop ceremony answered from the laptop's own passkey instead of a phone. */
export class PhoneRequiredError extends PasskeyPolicyError {
  constructor() {
    super("Use your phone for this step: scan the QR code with the phone that holds your passkey.")
    this.name = "PhoneRequiredError"
  }
}

/** A phone ceremony was answered by another device instead of this phone's own passkey. */
export class LocalPasskeyRequiredError extends PasskeyPolicyError {
  constructor() {
    super("Use this phone's own passkey, not another device.")
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

/** The creation response named a manager measured as unable to serve the wallet. */
export class UnsupportedProviderError extends PasskeyPolicyError {
  constructor(public readonly providerName: string) {
    super(
      `${providerName} passkeys can't protect a wallet yet. Delete the passkey it just made, then ` +
        "try again with iCloud Keychain, Google Password Manager, or 1Password.",
    )
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
      "No wallet was found for this passkey from this device. Open zk.money on the device you " +
        "signed up on, or sign in with the passkey you registered with.",
    )
    this.name = "NoWalletForPasskeyError"
  }
}

/** This browser reports no way to reach a phone, or is too old to have one. */
export class PhoneUnreachableError extends PasskeyPolicyError {
  constructor() {
    super(
      "This browser can't reach your phone to unlock the wallet. Update it, or open zk.money in a " +
        "current version of Chrome or Safari.",
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
    super("This passkey matches more than one wallet, so zk.money cannot tell which one to open.")
    this.name = "AmbiguousPasskeyError"
  }
}

export function isPasskeyPolicyError(err: unknown): err is PasskeyPolicyError {
  return err instanceof PasskeyPolicyError
}

/** No passkey session on this device: not a refusal, the screen re-enters through `/enter`. */
export class NoPasskeySessionError extends Error {
  constructor() {
    super("no passkey session on this device — enter with your passkey first")
    this.name = "NoPasskeySessionError"
  }
}

/**
 * The session changed while a ceremony was open (a commit or sign-out here, a logout or account
 * switch in another tab): the result is dropped, and whoever changed the session owns the tab.
 */
export class SessionChangedError extends Error {
  constructor() {
    super("the session changed while the passkey prompt was open")
    this.name = "SessionChangedError"
  }
}
