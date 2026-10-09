import type { PasskeyHint } from "../ceremony/passkeyCeremony.js"
import { type PhoneReach, MAC_FIREFOX_FLOOR, MAC_SAFARI_FLOOR } from "./passkeyCapabilities.js"
import { IOS_PASSKEY_FLOOR } from "./userAgentInfo.js"

export const UNSUPPORTED_BROWSER_MESSAGE =
  "This browser doesn't support passkeys, or the browser features the wallet needs with them. " +
  "Use a recent version of Chrome, Safari, Edge or Firefox to create your account."

/**
 * The words a screen shows for a refusal, the phone steps, and the iOS floor notice. Data only:
 * each consumer renders it with its own components, so both web fronts say the same thing.
 */

/**
 * A refusal's title and whether another attempt can help; `message` replaces the error's own body.
 * `openInBrowser` marks a row whose way out is the phone's own browser.
 */
export type RefusalRow = { title: string; retry: boolean; message?: string; openInBrowser?: true }

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
  PhoneUnreachableError: { title: "Update this browser, or use Chrome", retry: false },
  NoWalletForPasskeyError: { title: "No wallet for this passkey", retry: true },
  RotatedCredentialError: { title: "This passkey's key changed", retry: false },
  AmbiguousPasskeyError: { title: "Contact support", retry: false },
}

export const REFUSAL_FALLBACK: RefusalRow = { title: "Couldn't use this passkey", retry: true }

/** An iOS app's built-in browser rejected the passkey the way a closed sheet does. */
export const IN_APP_BROWSER_REFUSAL = "InAppBrowser"

const IN_APP_ROW: RefusalRow = {
  title: "This browser couldn't use a passkey",
  retry: true,
  openInBrowser: true,
  message: "If you opened this link inside another app, open it in your phone's browser instead.",
}

/**
 * A browser that cannot run a passkey, most often an app's built-in one. Apart from
 * `REFUSAL_ROWS` because neither is a policy error. The iOS in-app row offers no retry: that
 * browser has never answered a passkey request.
 */
export const IN_APP_BROWSER_ROWS: Readonly<Record<string, RefusalRow>> = {
  NotSupportedError: IN_APP_ROW,
  [IN_APP_BROWSER_REFUSAL]: { ...IN_APP_ROW, retry: false },
}

/**
 * The line under a refusal whose error says a passkey was written (`passkeyWritten`). Each front
 * builds the href from its passkeys docs URL and `anchor`.
 */
export const LEFTOVER_PASSKEY_COPY = {
  line: "A passkey may have been saved.",
  link: "How to delete it",
  anchor: "leftover-passkey",
} as const

/**
 * The words around an Open in browser link. `hintAlone` stands where no link is shown. In X's app,
 * which drops the link, `xMenu` follows Copy link and `xMenuAlone` stands where no link is shown.
 */
export const OPEN_IN_BROWSER_COPY = {
  open: "Open in browser",
  hint: "Or tap ⋯ in this app and choose Open in browser.",
  hintAlone: "Tap ⋯ in this app and choose Open in browser.",
  xMenu: "Or tap ⋮ next to the web address at the bottom, then Open in browser.",
  xMenuAlone: "Tap ⋮ next to the web address at the bottom, then Open in browser.",
  copyLink: "Copy link",
  copied: "Copied",
  copiedStatus: "Link copied.",
  copyFailed: "Couldn't copy. Press and hold the address above to select and copy it.",
} as const

/**
 * The card shown in an app's built-in browser before any passkey request. The title names the
 * problem and the way-out block under it names the step, which differs by what the address can
 * carry.
 */
export const IN_APP_UP_FRONT_COPY = {
  title: "Passkeys don't work in this app's browser",
  line: "zk.money uses a passkey to create and open your account.",
} as const

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
 * One control on the sign-up sheet: which authenticator the user says will answer, and the hint
 * that steers the browser towards it. The first route is the sheet's button and opens the browser's
 * prompt; a creation asks for a cross-device authenticator outright, so the prompt opens on the
 * route the hint names. A second route is the link under it: it opens the sheet's key variant,
 * whose own button opens the prompt.
 */
export type StepsRoute = { hint: PasskeyHint; label: string }

const SECURITY_KEY_INSTEAD = "Have a security key? Use it instead"

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
  /** The laptop sign-up sheet: what to do with the browser's QR code, and why the phone. */
  title: "Scan QR code to save the key on your phone",
  subtitle: "This creates your account. One-time setup, about 20 seconds.",
  why: {
    title: "Why use the phone?",
    body: "A passkey saved on your phone can sync across your devices.",
    /** Follows the body as a link to the passkeys docs page; each front supplies the URL. */
    link: "How passkeys work on zk.money",
  },
  /**
   * The managers and keys a creation admits, opened from a label under the reason for the phone,
   * and what it refuses, so the wrong manager is learnt of before the prompt rather than after it.
   */
  supported: {
    label: "Supported passkeys",
    title: "Works with",
    providers: [
      "iCloud Keychain (Apple Passwords)",
      "Google Password Manager",
      "1Password",
      "YubiKey 5 security key",
    ],
    refused:
      "Other managers, such as Bitwarden, Proton Pass, LastPass or Windows Hello, aren't " +
      "supported yet.",
  },
  /**
   * Under the supported list on the laptop sheet: a label whose tooltip says why the passkey is the
   * only way in, for a synced passkey and for a key. `line` is the one-sentence form beside a
   * phone's own sign-up button; the key variant says it in `noPhone.note`.
   */
  loss: {
    label: "Lose your passkey, lose the wallet.",
    line: "There is no account recovery. Lose your passkey, lose the wallet.",
    title: "Your passkey is the only way in",
    body: [
      "There is no account recovery. zk.money cannot restore a wallet whose passkey is gone.",
      "A passkey in a password manager syncs to your other devices. That sync is your backup.",
      "A security key keeps the only copy. A second key can't be a backup, because two keys can't " +
        "share one passkey's secret: lose the key, lose the wallet.",
    ],
  },
  /**
   * A gold label in the card, shown where something on this computer can answer a sign-up that
   * needs the phone: a password manager's extension, or Windows Hello. Its tooltip says what to
   * pick instead; `extension` is the part for a browser where an extension answers.
   */
  thisComputer: {
    label: "Don't save the passkey on this computer",
    title: "Use your phone or security key",
    extension: [
      "Password manager extensions such as Bitwarden, Proton Pass or Dashlane can pop up and " +
        "offer to save your passkey on this computer. Don't save it there: choose the " +
        "extension's option to use another device or hardware key, and your browser's prompt " +
        "takes over.",
      "Closing the pop-up can cancel the sign-up. If your browser's prompt doesn't appear, leave " +
        "full screen and try again.",
    ],
    refused: "A passkey saved on this computer is refused.",
  },
  /**
   * The one-sentence form, where there is no card: the security-key sheet and the campaign's help
   * card. A manager on the phone is accepted, so it names this computer's. Closing a manager's
   * window can end the sign-up and managers word their way past differently, so it says what not
   * to do and leaves the rest conditional.
   */
  extension:
    "If a password manager pops up on this computer, don't save the passkey there. Choose " +
    "another device or hardware key if it offers one.",
  routes: [
    { hint: "hybrid", label: "Show QR Code" },
    { hint: "security-key", label: SECURITY_KEY_INSTEAD },
  ] as readonly StepsRoute[],
  caption:
    "Transactions are approved with your passkey: on this computer when it holds a synced copy, " +
    "otherwise on the phone or security key that holds it.",
  cancelLabel: "Cancel",
  /**
   * The key variant: shown where the browser reports no route to a phone, and where the user picks
   * the key on the phone variant.
   */
  noPhone: {
    hero: { glyph: "security-key", title: "Have your security key ready" } as StepsHero,
    createSteps: [
      "Plug in the security key that will hold your new passkey.",
      "Tap below, then follow your browser's prompts.",
    ],
    title: "Create account with your security key",
    subtitle: "One-time setup. About 20 seconds.",
    note:
      "Your security key keeps the only copy of your passkey. A second key can't be added as a " +
      "backup, and there is no account recovery: lose the key, lose the wallet.",
    /** The allowlist admits the Yubico family, but one model is verified end to end. */
    models:
      "YubiKey 5 series keys are supported today (tested with a YubiKey 5 NFC). Another key may " +
      "fail only after it has saved a passkey, which you'd then need to remove yourself.",
    /** Back to the phone variant; offered only where a phone route exists. */
    back: "Use my phone instead",
    routes: [
      { hint: "security-key", label: "Create account with my security key" },
    ] as readonly StepsRoute[],
    caption:
      "This computer can't reach a phone, so a security key is the only passkey it can use, and a " +
      "key keeps the only copy of what it holds. If a phone holds your passkey, open zk.money on a " +
      "computer that can reach it.",
  },
} as const

/**
 * The card a laptop sign-up gets when the browser's sheet closed before a passkey came back, and the
 * panel
 * that hands the page to the phone. `quick` follows a request closed within 10 seconds, `slow` one
 * open longer; `noPhone` follows a closed security-key sheet on a computer that can't reach a phone.
 * Each answer carries the value its report sends.
 */
export const PHONE_HELP_COPY = {
  quick: {
    title: "Create your passkey with your phone",
    body: "The next prompt shows a QR code. Scan it with your phone's camera to save your passkey there.",
  },
  slow: {
    title: "Your phone didn't connect",
    body:
      "Check that Bluetooth is on for this computer and your phone, and that your phone is " +
      "online, then try again.",
  },
  noPhone: {
    title: "Sign up on your phone instead?",
    body:
      "This computer can't reach a phone, so here it can only use a security key. If you don't " +
      "have one, open zk.money on your phone and sign up there.",
    retry: "Try again with my security key",
  },
  windows:
    'If Windows offers Windows Hello or "This Windows device", choose "iPhone, iPad or Android ' +
    'device" instead.',
  /** The title where an extension answers passkeys: its window, not the phone, may have ended it. */
  extensionTitle: "That didn't finish",
  tryAgain: "Try again",
  phoneLink: "Sign up on your phone instead",
  securityKey: SECURITY_KEY_INSTEAD,
  link: {
    title: "Sign up on your phone",
    body: "Scan this code with your phone's camera to open zk.money there.",
    inviteKept: "Your invite is kept.",
    qrLabel: "QR code that opens this page on your phone",
  },
  question: {
    title: "What happened?",
    placeholder: "Pick one (optional)",
    answers: [
      { value: "no_phone", label: "Didn't have my phone" },
      { value: "no_bluetooth", label: "Bluetooth is off or missing" },
      { value: "windows_hello", label: "Windows asked for Windows Hello / PIN", windowsOnly: true },
      { value: "phone_failed", label: "Phone didn't connect" },
      { value: "other", label: "Something else" },
    ],
    thanks: "Thanks.",
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

/** Shown before a ceremony, and as its refusal, where the browser claims an iOS below the floor. */
export const IOS_FLOOR_COPY =
  `zk.money needs iOS ${IOS_PASSKEY_FLOOR} or later to use passkeys. Update iOS in Settings, or ` +
  "use another device."

/** The refusal for a Mac browser below the sign-up floor. Safari updates apart from macOS. */
export const MAC_BROWSER_FLOOR_COPY =
  `Signing up on a Mac needs Safari ${MAC_SAFARI_FLOOR} or later, or Firefox ${MAC_FIREFOX_FLOOR} ` +
  "or later. Update this browser, or sign up in Chrome or on your phone. Safari updates are in " +
  "System Settings > General > Software Update."
