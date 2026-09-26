import type { PasskeyHint } from "../ceremony/passkeyCeremony.js"
import type { PhoneReach } from "./passkeyCapabilities.js"

export const UNSUPPORTED_BROWSER_MESSAGE =
  "This browser doesn't support passkeys, or the browser features the wallet needs with them. " +
  "Use a recent version of Chrome, Safari, Edge or Firefox to create your account."

/**
 * The words a screen shows for a refusal, the phone steps, and the iOS floor notice. Data only:
 * each consumer renders it with its own components, so both web fronts say the same thing.
 */

/** A refusal's title and whether another attempt can help; `message` replaces the error's own body. */
export type RefusalRow = { title: string; retry: boolean; message?: string }

/** One row per policy error, keyed by the error's stable name. */
export const REFUSAL_ROWS: Readonly<Record<string, RefusalRow>> = {
  // Named for both routes: a refusal is raised after the ceremony, where the browser's answer
  // about reaching a phone is no longer at hand, and both routes are open on every laptop.
  RelatedOriginPasskeyError: { title: "Passkeys unavailable on this site", retry: false },
  PhoneRequiredError: { title: "Use your phone or a security key", retry: true },
  LocalPasskeyRequiredError: { title: "Use this phone or a security key", retry: true },
  SecurityKeyRequiredError: { title: "Keep using the same security key", retry: true },
  DeviceBoundPasskeyError: { title: "This passkey can't be backed up", retry: true },
  IncompleteCreationError: { title: "This browser couldn't finish", retry: true },
  NoPrfError: { title: "Try a different passkey manager", retry: true },
  SecurityKeyNoPrfError: { title: "This device can't use that security key", retry: true },
  SingleSaltProviderError: { title: "Try a different passkey manager", retry: true },
  UnsupportedProviderError: { title: "That passkey provider isn't supported", retry: true },
  PhoneUnreachableError: { title: "Update this browser to continue", retry: true },
  NoWalletForPasskeyError: { title: "No wallet for this passkey", retry: true },
  RotatedCredentialError: { title: "This passkey's key changed", retry: false },
  AmbiguousPasskeyError: { title: "Contact support", retry: false },
}

export const REFUSAL_FALLBACK: RefusalRow = { title: "Couldn't use this passkey", retry: true }

/** What a screen keeps of a refusal: the error's stable name and its own words. */
export type RefusalState = { name: string; message: string }

/** The row for an error; a consumer's `extraRows` add rows for its own errors or replace shared ones. */
export function refusalFor(
  error: { name: string },
  extraRows?: Readonly<Record<string, RefusalRow>>,
): RefusalRow {
  return extraRows?.[error.name] ?? REFUSAL_ROWS[error.name] ?? REFUSAL_FALLBACK
}

/** The device to fetch, drawn above the steps, and the line that says so for readers who skim. */
export type StepsHero = { glyph: "phone" | "security-key"; title: string }

/**
 * One button on the sheet: which authenticator the user says will answer, and the hint that steers
 * the browser towards it. A creation asks for a cross-device authenticator outright, so the sheet
 * opens on the route the hint names. A sign-in cannot: the browser weighs the hint against the
 * passkeys it can already reach, and may open its own list instead, which is why the steps ask the
 * user to choose the route there rather than promise it is chosen for them.
 */
export type StepsRoute = { hint: PasskeyHint; label: string }

/**
 * The two things a laptop user does next, shown before every ceremony. The passkey may live on a
 * phone or on a security key and the screens cannot tell which, so the steps name both routes
 * rather than send half the users after the wrong one.
 */
export const PHONE_STEPS_COPY = {
  hero: { glyph: "phone", title: "Have your phone or security key ready" } as StepsHero,
  /**
   * Shown where the routes are offered, which is only a creation: it asks for a cross-device
   * authenticator outright, so the prompt opens on the route the user picks.
   */
  createSteps: [
    "Your new passkey will be saved on your phone or a security key.",
    "Choose one below, then follow your browser's prompts.",
  ],
  continueLabel: "Continue",
  routes: [
    { hint: "hybrid", label: "Scan a QR code with my phone" },
    { hint: "security-key", label: "Use my security key" },
  ] as readonly StepsRoute[],
  caption:
    "Transactions are approved with your passkey: on this computer when it holds a synced copy, " +
    "otherwise on the phone or security key that holds it.",
  cancelLabel: "Cancel",
  /**
   * Replaces the hero and steps above where the browser reports no route to a phone. It cannot know
   * whether this wallet's passkey is on a key or on a phone, so it says what to do in either case.
   */
  noPhone: {
    hero: { glyph: "security-key", title: "Have your security key ready" } as StepsHero,
    createSteps: [
      "Plug in the security key that will hold your new passkey.",
      "Tap below, then follow your browser's prompts.",
    ],
    routes: [
      { hint: "security-key", label: "Continue with my security key" },
    ] as readonly StepsRoute[],
    caption:
      "This computer can't reach a phone, so a security key is the only passkey it can use, and a " +
      "key keeps the only copy of what it holds. If a phone holds your passkey, open zk.money on a " +
      "computer that can reach it.",
  },
} as const

/**
 * The laptop sign-in sheet. The browser cannot be steered to one device — its own account chooser
 * lists every passkey it can reach and honours no routing hint — so the sheet does not promise a
 * device. It names the one action and lets the browser's prompt offer whatever holds the passkey:
 * this computer's synced copy, a phone over QR, or a security key.
 */
export const SIGN_IN_SHEET_COPY = {
  title: "Sign in",
  subtitle: "Continue with the passkey you made when you signed up.",
  continueLabel: "Continue",
  cancelLabel: "Cancel",
} as const

/**
 * The card for a record mismatch, by verdict. `wrong-key` is certain — this computer's copy is
 * returning a key that is not the account's, a known Apple bug — so there is no retry: the same
 * copy would answer again, and the card sends the user to "Show passkeys" to pick another device.
 * `not-reproduced` is the weaker "this attempt didn't open it", which a re-run or another device
 * may still resolve.
 */
export const MISMATCH_COPY: Readonly<Record<"wrong-key" | "not-reproduced", RefusalRow>> = {
  "wrong-key": {
    title: "This computer is returning the wrong key",
    retry: false,
    message:
      "This computer's copy of your passkey is returning the wrong key — a known Apple bug on some " +
      "macOS versions. Your wallet is fine; choose Show passkeys and, in the browser's prompt, pick " +
      "your phone (scan the QR code with it) or a security key.",
  },
  "not-reproduced": {
    title: "That didn't open your wallet",
    retry: true,
    message:
      "That passkey didn't open your wallet this time. Try again, or open it with your phone or a " +
      "security key.",
  },
}

/**
 * A phone's one-tap step before a sign-in's second prompt. The first approval could not settle
 * which key the passkey holds, and a prompt that opens seconds after the last tap may be refused
 * by the browser, so the tap is asked for rather than assumed.
 */
export const APPROVE_AGAIN_COPY = {
  title: "One more approval",
  body: "On a new browser, your passkey has to approve twice so the wallet can be sure it has the right key. Approve once more to finish signing in.",
  continueLabel: "Continue",
  cancelLabel: "Cancel",
} as const

/**
 * The steps to show for what the browser said about reaching a phone. Both fronts call this rather
 * than matching on the reach themselves, so the two never drift.
 */
export const stepsCopyFor = (reach: PhoneReach) =>
  reach === "no-hybrid" ? PHONE_STEPS_COPY.noPhone : PHONE_STEPS_COPY

/** A warning, never a block, for a phone whose browser claims an iOS below the passkey floor. */
export const IOS_FLOOR_COPY =
  "Passkeys on iOS before 18.4 had a known bug in this step. If it fails, check Settings for an " +
  "iOS update and try again."
