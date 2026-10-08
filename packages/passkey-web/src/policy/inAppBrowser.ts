import { IN_APP_BROWSER_REFUSAL, type RefusalState } from "./refusalCopy.js"
import { currentUserAgentInfoSync, type OsFamily, type UserAgentInfo } from "./userAgentInfo.js"

/**
 * An iOS browser that names no known family: an app's own web view (X, Instagram, ...), where
 * passkeys fail at once. Apps that open Safari's own view send Safari's user agent and pass.
 */
export function isIosInAppBrowser(
  info: Pick<UserAgentInfo, "osFamily" | "browserFamily">,
): boolean {
  return info.osFamily === "ios" && info.browserFamily === "unknown"
}

/**
 * A link that opens `url` in the phone's browser: Safari on iOS, Chrome on Android. Whether it
 * works is up to the app hosting the page, so callers keep a manual way out beside it. Built
 * from the parsed URL, without user info or fragment.
 */
export function openInBrowserHref(url: string, osFamily: OsFamily): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const scheme = parsed.protocol.slice(0, -1)
  if (scheme !== "https" && scheme !== "http") return undefined
  const target = `${parsed.host}${parsed.pathname}${parsed.search}`
  if (osFamily === "ios") return `x-safari-${scheme}://${target}`
  if (osFamily === "android") {
    return `intent://${target}#Intent;scheme=${scheme};package=com.android.chrome;end`
  }
  return undefined
}

/** A Home Screen web app: it sends an app web view's user agent, but runs passkeys as Safari does. */
function isHomeScreenWebApp(): boolean {
  return (globalThis.navigator as { standalone?: boolean } | undefined)?.standalone === true
}

/** Telegram's own browser sends Safari's user agent; the bridge it injects into every page doesn't. */
function isTelegramWebView(): boolean {
  return (globalThis as { TelegramWebviewProxy?: unknown }).TelegramWebviewProxy !== undefined
}

/** The live browser's answer: its user-agent string or Telegram's bridge, less a Home Screen web app. */
export function currentIsIosInAppBrowser(): boolean {
  const info = currentUserAgentInfoSync()
  const inApp = isIosInAppBrowser(info) || (info.osFamily === "ios" && isTelegramWebView())
  return inApp && !isHomeScreenWebApp()
}

/**
 * An app's own browser, as far as its user agent tells: an iOS app's web view, or Android's (`wv`).
 * Neither answers a passkey request, so a retry there can't help.
 */
export function currentIsInAppBrowser(): boolean {
  if (currentUserAgentInfoSync().osFamily === "android") {
    return /;\s*wv\)/.test(globalThis.navigator?.userAgent ?? "")
  }
  return currentIsIosInAppBrowser()
}

/**
 * What an app's own browser is told before any passkey request: `leave`, on iOS and Android alike.
 * An Android app can turn passkeys on in its web view, but none that reaches the page does, so no
 * way to try is offered. Nothing in a real browser.
 */
export type InAppUpFront = "leave"

export function currentInAppUpFront(): InAppUpFront | undefined {
  return currentIsInAppBrowser() ? "leave" : undefined
}

/** The way out for this device: on Android, or in an iOS in-app browser; nothing elsewhere. */
export function currentOpenInBrowserHref(url: string): string | undefined {
  const info = currentUserAgentInfoSync()
  if (info.osFamily !== "android" && !currentIsIosInAppBrowser()) return undefined
  return openInBrowserHref(url, info.osFamily)
}

/**
 * Whether the app hosting the page drops the Open in browser link: X's app does on iPhone and on
 * Android, so there no link is offered and Copy link leads, with the app's own menu after it.
 */
export function currentAppDropsOpenLink(): boolean {
  const userAgent = globalThis.navigator?.userAgent ?? ""
  const xIphone = currentIsIosInAppBrowser() && /\bTwitter for iPhone\b/.test(userAgent)
  const xAndroid =
    currentUserAgentInfoSync().osFamily === "android" && /\bTwitterAndroid\b/.test(userAgent)
  return xIphone || xAndroid
}

/**
 * The in-app refusal a failed passkey request calls for, if any: a browser that cannot run
 * passkeys, or an iOS app's web view, whose rejection looks like a closed sheet. Matched by name,
 * because a `DOMException` is not an `Error` in every realm.
 */
export function inAppBrowserRefusal(err: unknown): RefusalState | undefined {
  const { name, message } = (err ?? {}) as { name?: unknown; message?: unknown }
  const text = typeof message === "string" ? message : ""
  if (name === "NotSupportedError") return { name, message: text }
  if (name === "NotAllowedError" && currentIsIosInAppBrowser()) {
    return { name: IN_APP_BROWSER_REFUSAL, message: text }
  }
  return undefined
}
