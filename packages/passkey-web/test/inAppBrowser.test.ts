// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  currentIsIosInAppBrowser,
  currentAppDropsOpenLink,
  currentInAppUpFront,
  currentIsInAppBrowser,
  currentOpenInBrowserHref,
  inAppBrowserRefusal,
  isIosInAppBrowser,
  openInBrowserHref,
} from "../src/policy/inAppBrowser.js"
import { parseUserAgent } from "../src/policy/userAgentInfo.js"

/** Shapes of published user agents, not device captures. */
const UA = {
  iosSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iosChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  iosFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  iosEdge:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/126.0.2592.56 Version/18.0 Mobile/15E148 Safari/604.1",
  iosDuckDuckGo:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15",
  iosWebView:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
  iosInstagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 370.0.0.0.0 (iPhone15,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556; 000000000)",
  iosFacebook:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.0;FBBV/0;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.5;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/5]",
  iosGoogleApp:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/380.0.0 Mobile/15E148 Safari/604.1",
  // Telegram-iOS's in-app browser builds Safari's user agent, with the device's build number.
  iosTelegram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/22F76 Safari/604.1",
  iosLinkedIn:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.29.1234",
  androidLinkedIn:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 [LinkedInApp]",
  ipadWebView:
    "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36",
  androidWebView:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
}

const inApp = (userAgent: string) => isIosInAppBrowser(parseUserAgent({ userAgent }))

describe("isIosInAppBrowser", () => {
  it.each([
    ["iOS Safari", UA.iosSafari],
    ["iOS Chrome", UA.iosChrome],
    ["iOS Firefox", UA.iosFirefox],
    ["iOS Edge", UA.iosEdge],
    ["iOS DuckDuckGo", UA.iosDuckDuckGo],
  ])("leaves a named iOS browser alone: %s", (_name, userAgent) => {
    expect(inApp(userAgent)).toBe(false)
  })

  it.each([
    ["a bare web view", UA.iosWebView],
    ["X", UA.iosX],
    ["Instagram", UA.iosInstagram],
    ["Facebook", UA.iosFacebook],
    ["an iPad web view", UA.ipadWebView],
    // The rule's answer, not a verified fact about the Google app.
    ["the Google app", UA.iosGoogleApp],
  ])("flags an iOS browser that names no family: %s", (_name, userAgent) => {
    expect(inApp(userAgent)).toBe(true)
  })

  it.each([
    ["Android Chrome", UA.androidChrome],
    ["an Android web view", UA.androidWebView],
    ["macOS Safari", UA.macSafari],
    ["Windows Chrome", UA.windowsChrome],
    ["nothing", ""],
  ])("is iOS-only: %s", (_name, userAgent) => {
    expect(inApp(userAgent)).toBe(false)
  })
})

describe("openInBrowserHref", () => {
  const url = "https://launch.zk.money/?invite=bcd2345"

  it("opens Safari on iOS and Chrome on Android", () => {
    expect(openInBrowserHref(url, "ios")).toBe("x-safari-https://launch.zk.money/?invite=bcd2345")
    expect(openInBrowserHref(url, "android")).toBe(
      "intent://launch.zk.money/?invite=bcd2345#Intent;scheme=https;package=com.android.chrome;end",
    )
  })

  it("drops the fragment on both, so the intent's trailer is the only one", () => {
    const withFragment = "https://h/p?q=1#h=abc.def"
    expect(openInBrowserHref(withFragment, "ios")).toBe("x-safari-https://h/p?q=1")
    expect(openInBrowserHref(withFragment, "android")).toBe(
      "intent://h/p?q=1#Intent;scheme=https;package=com.android.chrome;end",
    )
  })

  it("keeps the port, path and query exactly as parsed, and drops user info", () => {
    const tricky = "https://h:8443/a;component=foo/%23x?y=%25"
    expect(openInBrowserHref(tricky, "ios")).toBe(
      "x-safari-https://h:8443/a;component=foo/%23x?y=%25",
    )
    expect(openInBrowserHref(tricky, "android")).toBe(
      "intent://h:8443/a;component=foo/%23x?y=%25#Intent;scheme=https;package=com.android.chrome;end",
    )
    expect(openInBrowserHref("https://u:p@h/", "ios")).toBe("x-safari-https://h/")
    expect(openInBrowserHref("https://u:p@h/", "android")).toBe(
      "intent://h/#Intent;scheme=https;package=com.android.chrome;end",
    )
  })

  it("carries http for local dev", () => {
    expect(openInBrowserHref("http://localhost:5173/x", "ios")).toBe(
      "x-safari-http://localhost:5173/x",
    )
    expect(openInBrowserHref("http://localhost:5173/x", "android")).toBe(
      "intent://localhost:5173/x#Intent;scheme=http;package=com.android.chrome;end",
    )
  })

  it("has nothing for other systems, unparseable URLs or other schemes", () => {
    for (const os of ["macos", "windows", "linux", "chromeos", "unknown"] as const) {
      expect(openInBrowserHref(url, os)).toBeUndefined()
    }
    expect(openInBrowserHref("not a url", "ios")).toBeUndefined()
    expect(openInBrowserHref("data:text/html,hi", "android")).toBeUndefined()
  })
})

describe("the live browser", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const page = "https://launch.zk.money/"

  it("offers the way out on Android and in an iOS in-app browser only", () => {
    vi.stubGlobal("navigator", { userAgent: UA.androidWebView })
    expect(currentIsIosInAppBrowser()).toBe(false)
    expect(currentOpenInBrowserHref(page)).toBe(
      "intent://launch.zk.money/#Intent;scheme=https;package=com.android.chrome;end",
    )

    vi.stubGlobal("navigator", { userAgent: UA.iosX })
    expect(currentIsIosInAppBrowser()).toBe(true)
    expect(currentOpenInBrowserHref(page)).toBe("x-safari-https://launch.zk.money/")

    for (const userAgent of [UA.iosSafari, UA.macSafari]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentIsIosInAppBrowser()).toBe(false)
      expect(currentOpenInBrowserHref(page)).toBeUndefined()
    }
  })

  it("answers no without a navigator", () => {
    vi.stubGlobal("navigator", undefined)
    expect(currentIsIosInAppBrowser()).toBe(false)
    expect(currentOpenInBrowserHref(page)).toBeUndefined()
  })

  it("takes a Home Screen web app, which sends a web view's user agent, for Safari", () => {
    vi.stubGlobal("navigator", { userAgent: UA.iosWebView, standalone: true })
    expect(currentIsIosInAppBrowser()).toBe(false)
    expect(currentOpenInBrowserHref(page)).toBeUndefined()
    expect(inAppBrowserRefusal({ name: "NotAllowedError", message: "closed" })).toBeUndefined()

    vi.stubGlobal("navigator", { userAgent: UA.iosWebView, standalone: false })
    expect(currentIsIosInAppBrowser()).toBe(true)
  })

  it("tells an app's own browser from a real one on both platforms", () => {
    for (const userAgent of [UA.iosX, UA.iosWebView, UA.androidWebView]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentIsInAppBrowser()).toBe(true)
    }
    for (const userAgent of [UA.iosSafari, UA.androidChrome, UA.macSafari]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentIsInAppBrowser()).toBe(false)
    }
    vi.stubGlobal("navigator", { userAgent: UA.iosWebView, standalone: true })
    expect(currentIsInAppBrowser()).toBe(false)
  })

  it("tells an app's browser to leave on iPhone and on Android, and nothing elsewhere", () => {
    // Every fixture is a published shape, not a device capture.
    for (const userAgent of [
      UA.iosX,
      UA.iosInstagram,
      UA.iosFacebook,
      UA.iosWebView,
      UA.iosLinkedIn,
      UA.androidWebView,
      `${UA.androidWebView} TwitterAndroid`,
      UA.androidLinkedIn,
    ]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentInAppUpFront()).toBe("leave")
    }
    for (const userAgent of [
      UA.iosSafari,
      UA.iosChrome,
      UA.androidChrome,
      UA.macSafari,
      UA.windowsChrome,
    ]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentInAppUpFront()).toBeUndefined()
    }
    vi.stubGlobal("navigator", { userAgent: UA.iosWebView, standalone: true })
    expect(currentInAppUpFront()).toBeUndefined()
    vi.stubGlobal("navigator", undefined)
    expect(currentInAppUpFront()).toBeUndefined()
  })

  it("knows Telegram's browser, which sends Safari's user agent, by the bridge it injects", () => {
    vi.stubGlobal("navigator", { userAgent: UA.iosTelegram })
    expect(currentIsIosInAppBrowser()).toBe(false)

    vi.stubGlobal("TelegramWebviewProxy", {})
    expect(currentIsIosInAppBrowser()).toBe(true)
    expect(currentInAppUpFront()).toBe("leave")
    // Telegram hands an x-safari link to iOS, so the link is offered.
    expect(currentAppDropsOpenLink()).toBe(false)
    expect(currentOpenInBrowserHref(page)).toBe("x-safari-https://launch.zk.money/")
    expect(inAppBrowserRefusal({ name: "NotAllowedError", message: "" })).toEqual({
      name: "InAppBrowser",
      message: "",
    })

    vi.stubGlobal("navigator", { userAgent: UA.iosTelegram, standalone: true })
    expect(currentIsIosInAppBrowser()).toBe(false)
    vi.stubGlobal("navigator", { userAgent: UA.macSafari })
    expect(currentIsIosInAppBrowser()).toBe(false)
  })

  it("knows only X's app drops the link, on iPhone and on Android", () => {
    const androidX = `${UA.androidWebView} TwitterAndroid`
    for (const userAgent of [UA.iosX, androidX]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentAppDropsOpenLink()).toBe(true)
    }
    for (const userAgent of [UA.iosWebView, UA.iosInstagram, UA.iosSafari, UA.androidWebView]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentAppDropsOpenLink()).toBe(false)
    }
    vi.stubGlobal("navigator", { userAgent: UA.iosX, standalone: true })
    expect(currentAppDropsOpenLink()).toBe(false)
    vi.stubGlobal("navigator", undefined)
    expect(currentAppDropsOpenLink()).toBe(false)
  })
})

describe("inAppBrowserRefusal", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const unsupported = { name: "NotSupportedError", message: "Error connecting to service" }
  const closed = { name: "NotAllowedError", message: "The operation was not allowed." }

  it("refuses a browser that can't run passkeys on any device", () => {
    for (const userAgent of [UA.androidWebView, UA.iosSafari, UA.macSafari]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(inAppBrowserRefusal(unsupported)).toEqual(unsupported)
    }
  })

  it("reads a closed sheet as the in-app browser only in an iOS web view", () => {
    for (const userAgent of [UA.iosX, UA.iosWebView]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(inAppBrowserRefusal(closed)).toEqual({ name: "InAppBrowser", message: closed.message })
    }
    for (const userAgent of [UA.iosSafari, UA.androidChrome, UA.macSafari]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(inAppBrowserRefusal(closed)).toBeUndefined()
    }
  })

  it("leaves everything else to the caller", () => {
    vi.stubGlobal("navigator", { userAgent: UA.iosX })
    expect(inAppBrowserRefusal({ name: "AbortError", message: "aborted" })).toBeUndefined()
    expect(inAppBrowserRefusal(new Error("network"))).toBeUndefined()
    expect(inAppBrowserRefusal(null)).toBeUndefined()
    expect(inAppBrowserRefusal("NotSupportedError")).toBeUndefined()
  })

  it("matches by name, so a DOMException and a plain object both count", () => {
    vi.stubGlobal("navigator", { userAgent: UA.macSafari })
    expect(inAppBrowserRefusal(new DOMException("no", "NotSupportedError"))).toEqual({
      name: "NotSupportedError",
      message: "no",
    })
    expect(inAppBrowserRefusal({ name: "NotSupportedError" })).toEqual({
      name: "NotSupportedError",
      message: "",
    })
  })
})
