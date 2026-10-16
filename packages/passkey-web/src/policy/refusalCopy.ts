import type { PasskeyHint } from "../ceremony/passkeyCeremony.js"
import {
  type LaptopCreation,
  type LocalCreation,
  type LocalManager,
  MAC_FLOORS_ADMITTED,
} from "./laptopCreation.js"
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
  LaptopPasskeyRefusedError: { title: "Save the passkey somewhere else", retry: true },
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
 * The link under an Apple Passwords refusal (`belowMacFloor`), to the docs entry on where Apple
 * Passwords is admitted. Each front builds the href from its passkeys docs URL and `anchor`.
 */
export const APPLE_FLOOR_COPY = {
  link: "Why Apple Passwords is refused on this Mac",
  anchor: "save-somewhere-else",
} as const

/** Which wording the Safari line takes: `chrome` adds where Chrome can save, while Chrome admits Apple. */
export type SafariAdvice = "version" | "chrome"

const SAFARI_VERSION_UNREAD =
  "Safari doesn't report which macOS this Mac runs, so Apple Passwords can't be used here."

/** Under an Apple Passwords refusal on Safari's row, where the refusal is not about this Mac. */
export const SAFARI_REFUSAL_COPY: Readonly<Record<SafariAdvice, string>> = {
  version: SAFARI_VERSION_UNREAD,
  chrome: `${SAFARI_VERSION_UNREAD} Chrome can use it on ${MAC_FLOORS_ADMITTED}.`,
}

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

/**
 * The line the in-app card adds for a phone's Chrome below the floor whose brands say nothing, so
 * the page cannot tell a web view from Chrome: it suggests an update. In parts, so a front can link
 * the store.
 */
export const UPDATE_CHROME_COPY = {
  maybeBefore: "If you're already in Chrome, update it from the ",
  maybeLink: "Play Store",
  maybeAfter: " and open this page again, or use another browser.",
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
 * that steers the browser towards it. The first route is the variant's button and opens the
 * browser's prompt on the device its hint names; the routes after it are the links under the
 * button, each opening another variant whose own button opens the prompt.
 */
export type StepsRoute = { hint: PasskeyHint; label: string }

const USE_SECURITY_KEY = "Use a security key"
const USE_PHONE = "Use my phone"

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
  /** The laptop sign-up sheet: what to do with the browser's QR code. */
  title: "Scan QR code to create the passkey on your phone",
  /**
   * Under a variant's button, beside the docs link: a label whose tooltip lists the managers and
   * key a creation admits. A refused manager is named by its refusal, so the tooltip names none.
   */
  supported: {
    label: "Supported passkeys",
    title: "Works with",
    providers: [
      "iCloud Keychain",
      "Google Password Manager",
      "1Password",
      "YubiKey 5 security key",
    ],
    refused: "Other password managers aren't supported yet.",
  },
  /** A link to the passkeys docs page; each front supplies the URL. */
  docsLink: "How passkeys work on zk.money",
  /**
   * One sentence on the key variant where a password manager's extension answers passkeys, and on
   * the campaign's help card. The phone variant says nothing: a manager's answer there is refused
   * by name. A manager on the phone is accepted, so it names this computer's. Closing a manager's
   * window can end the sign-up and managers word their way past differently, so it says what not
   * to do and leaves the rest conditional.
   */
  extension:
    "If a password manager pops up on this computer, don't save the passkey there. Choose " +
    "another device or hardware key if it offers one.",
  routes: [
    { hint: "hybrid", label: "Show QR Code" },
    { hint: "security-key", label: USE_SECURITY_KEY },
  ] as readonly StepsRoute[],
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
    /** Heads the collapsed note and models lines. */
    detailsLabel: "About security keys",
    note:
      "Your security key keeps the only copy of your passkey. A second key can't be added as a " +
      "backup, and there is no account recovery: lose the key, lose the wallet.",
    /** The allowlist admits the Yubico family, but one model is verified end to end. */
    models: "YubiKey 5 series keys are supported today",
    /** Back to the phone variant; offered only where a phone route exists. */
    back: USE_PHONE,
    routes: [{ hint: "security-key", label: "Use security key" }] as readonly StepsRoute[],
    caption:
      "This computer can't reach a phone, so a security key is the only passkey it can use, and a " +
      "key keeps the only copy of what it holds. If a phone holds your passkey, open zk.money on a " +
      "computer that can reach it.",
  },
  /**
   * The local variant: shown where `laptopCreationFor` lets this laptop create on its own password
   * manager.
   */
  local: {
    title: "Create your passkey",
    routes: [
      { hint: "client-device", label: "Continue" },
      { hint: "hybrid", label: USE_PHONE },
      { hint: "security-key", label: USE_SECURITY_KEY },
    ] as readonly StepsRoute[],
    /** Back from the phone or key variant to this one. */
    back: "Back",
    /** On the phone variant, where this laptop could have created on its own manager. */
    switchToLocal: "Use this computer",
    /** Every control leading to this computer on a row with 1Password alone. */
    switchToOnePassword: "Have 1Password?",
    /** Above this computer's button where no extension answers; see `localNoteFor`. */
    pickOnePassword: "When your browser asks where to save the passkey, pick 1Password.",
    installExtension: "To use 1Password, install its browser extension and reload this page.",
    /** Shown when the sheet re-opens after the browser's prompt closed with nothing created. */
    unfinished: "Setup didn't finish. Try again, or use your phone.",
    /**
     * Under the button where a password manager's extension answers passkeys; see
     * `extensionLineFor`. The Supported passkeys tip beside it names what the browser's own prompt
     * may save in.
     */
    extension: "If a password manager pops up, dismiss it and use your browser's own prompt.",
    extensionOnePassword:
      "If 1Password pops up, save the passkey there. Dismiss any other password manager.",
    /** Added once a manager the row cannot use kept answering; see `repeatedRefusalLineFor`. */
    refusedOften:
      "A passkey zk.money can't use keeps being saved here. Pick one listed under Supported " +
      "passkeys.",
    /**
     * Why the sheet opened on another variant: a manager this row cannot use kept answering on
     * this computer. Keyed by the variant it opened on.
     */
    steered: {
      phone: "A passkey zk.money can't use keeps being saved here, so the phone comes first.",
      key: "A passkey zk.money can't use keeps being saved here, so the security key comes first.",
    },
  },
  /**
   * Where another browser keeps phone creation and Chrome would not: a label beside the supported
   * passkeys, whose tip says why. `apple` is for Safari and Firefox on a Mac, which cannot say
   * which macOS they run on; `gpm` for another browser on Windows or Linux, which has no Google
   * Password Manager.
   */
  chromeTip: {
    label: "Chrome recommended",
    title: "Skip the QR code",
    apple:
      `On ${MAC_FLOORS_ADMITTED}, Chrome can save the passkey in Apple Passwords ` +
      "with no QR code.",
    gpm: "In Chrome, you can save the passkey in Google Password Manager with no QR code.",
  },
} as const

/**
 * Under a sign-up refused for saving on this computer, where Chrome could have saved it here
 * (`chromeTip` of `gpm`).
 */
export const CHROME_REFUSAL_COPY = "Or sign up in Chrome and save it in Google Password Manager."

/**
 * The line above this computer's button where no extension answers. On a Mac either 1Password
 * surface returns key material, so only a row with 1Password alone needs a word; on Windows and
 * Linux the extension is the surface that does, so every row that lists 1Password says so.
 */
export function localNoteFor(creation: LocalCreation): string | undefined {
  if (!creation.managers.includes("1password")) return undefined
  if (creation.os !== "macos") return PHONE_STEPS_COPY.local.installExtension
  return creation.managers.length === 1 ? PHONE_STEPS_COPY.local.pickOnePassword : undefined
}

/**
 * The line under this computer's button where an extension answers. A row that lists 1Password
 * saves in its pop-up; any other extension's passkey is refused, so its pop-up is dismissed.
 */
export function extensionLineFor(creation: LocalCreation): string {
  const { extension, extensionOnePassword } = PHONE_STEPS_COPY.local
  return creation.managers.includes("1password") ? extensionOnePassword : extension
}

/**
 * Added under the local variant once a manager the row cannot use kept answering. None where
 * 1Password is the row's only manager: the sheet opens on another variant instead.
 */
export function repeatedRefusalLineFor(creation: LocalCreation): string | undefined {
  const alone = creation.managers.every((m) => m === "1password")
  return alone ? undefined : PHONE_STEPS_COPY.local.refusedOften
}

const SUPPORTED_NAMES: Readonly<Record<LocalManager, string>> = {
  "apple": "iCloud Keychain",
  "gpm": "Google Password Manager",
  "1password": "1Password",
}

/** The "Supported passkeys" tip: its label, heading, the names listed, and what is refused. */
export type SupportedCopy = {
  label: string
  title: string
  providers: readonly string[]
  refused: string
}

/**
 * The tip for a variant: the phone variant lists every manager a phone creation admits; the local
 * variant lists only the managers this row admits, and the key.
 */
export function supportedFor(creation?: LaptopCreation): SupportedCopy {
  if (!creation?.local) return PHONE_STEPS_COPY.supported
  return {
    ...PHONE_STEPS_COPY.supported,
    providers: [...creation.managers.map((m) => SUPPORTED_NAMES[m]), "YubiKey 5 security key"],
  }
}

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
  windows: 'In the next prompt, choose "iPhone, iPad or Android device", not Windows Hello.',
  /** The title where an extension answers passkeys: its window, not the phone, may have ended it. */
  extensionTitle: "That didn't finish",
  tryAgain: "Try again",
  phoneLink: "Sign up on your phone instead",
  securityKey: USE_SECURITY_KEY,
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

/** The phone variant, or the key-only one where no phone can be reached. */
type PhoneStepsCopy = typeof PHONE_STEPS_COPY | typeof PHONE_STEPS_COPY.noPhone

/**
 * The steps to show for what the browser said about reaching a phone, and for whether this laptop
 * may create on its own manager. Both fronts call this rather than matching on the reach
 * themselves, so the two never drift. The local variant drops its phone route where no phone can
 * be reached, keeping the key. A front that passes no creation never gets the local variant.
 */
export function stepsCopyFor(reach: PhoneReach): PhoneStepsCopy
export function stepsCopyFor(
  reach: PhoneReach,
  creation: LaptopCreation | undefined,
): PhoneStepsCopy | typeof PHONE_STEPS_COPY.local
export function stepsCopyFor(reach: PhoneReach, creation?: LaptopCreation) {
  if (creation?.local) {
    const local = PHONE_STEPS_COPY.local
    if (reach !== "no-hybrid") return local
    return { ...local, routes: local.routes.filter((r) => r.hint !== "hybrid") }
  }
  return reach === "no-hybrid" ? PHONE_STEPS_COPY.noPhone : PHONE_STEPS_COPY
}

/** Shown before a ceremony, and as its refusal, where the browser claims an iOS below the floor. */
export const IOS_FLOOR_COPY =
  `zk.money needs iOS ${IOS_PASSKEY_FLOOR} or later to use passkeys. Update iOS in Settings, or ` +
  "use another device."

/** The refusal for a Mac browser below the sign-up floor. Safari updates apart from macOS. */
export const MAC_BROWSER_FLOOR_COPY =
  `Signing up on a Mac needs Safari ${MAC_SAFARI_FLOOR} or later, or Firefox ${MAC_FIREFOX_FLOOR} ` +
  "or later. Update this browser, or sign up in Chrome or on your phone. Safari updates are in " +
  "System Settings > General > Software Update."

/** Which wording the advice takes: `use` where an extension answers this page's passkeys. */
export type ExtensionAdvice = "use" | "install"

const WINDOWS_PASSKEY_WINDOW =
  "If 1Password answered in the Windows passkey window, it can't give zk.money the key it needs " +
  "there."

/**
 * Under a refusal for want of key material on Windows, where this computer answered. 1Password's
 * Windows app, answering in the Windows passkey window, returns none; its browser extension does.
 * A refusal cannot always name what answered, so this is advice beside it, never a refusal of its
 * own.
 */
export const EXTENSION_ADVICE_COPY: Readonly<Record<ExtensionAdvice, string>> = {
  use: `${WINDOWS_PASSKEY_WINDOW} Use the 1Password browser extension's pop-up instead.`,
  install:
    `${WINDOWS_PASSKEY_WINDOW} Install or turn on the 1Password browser extension, reload this ` +
    "page, and use its pop-up.",
}
