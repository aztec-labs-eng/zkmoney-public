// @vitest-environment node
/** The laptop sign-up sheet's options, built from each browser's own row. */
import { describe, expect, it } from "vitest"
import {
  type LaptopCreation,
  type LocalCreation,
  type Withdrawn,
  WITHDRAWN,
  laptopCreationFor,
  withoutManager,
} from "../src/policy/laptopCreation.js"
import type { PhoneReach } from "../src/policy/passkeyCapabilities.js"
import type { PasskeyExtension } from "../src/policy/passkeyTelemetryVocabulary.js"
import { PHONE_HELP_COPY, PHONE_STEPS_COPY, SIGN_UP_SHEET_COPY } from "../src/policy/refusalCopy.js"
import {
  type SignUpChoice,
  type SignUpOptions,
  type SignUpOptionsInput,
  ignoresHintsFor,
  routeForChoice,
  signUpOptionsFor,
} from "../src/policy/signUpOptions.js"
import { type UserAgentInfo, parseUserAgent } from "../src/policy/userAgentInfo.js"

const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const WINDOWS_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const LINUX_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const CROS_UA =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const WINDOWS_FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0"
const LINUX_FIREFOX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0"

const chrome = { brand: "Google Chrome", version: "155" }
const edge = { brand: "Microsoft Edge", version: "155" }
const brave = { brand: "Brave", version: "155" }

/** A Chromium answering Client Hints. */
const hinted = (
  userAgent: string,
  platform: string,
  platformVersion: string,
  brand: { brand: string; version: string },
) =>
  parseUserAgent({
    userAgent,
    userAgentData: {
      platform,
      platformVersion,
      brands: [brand, { brand: "Chromium", version: "155" }],
    },
  })

const safari = (version: string) =>
  parseUserAgent({
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`,
  })
const macFirefox = (version: string) =>
  parseUserAgent({
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${version}) Gecko/20100101 Firefox/${version}`,
  })

const UA = {
  chromeOs: parseUserAgent({ userAgent: CROS_UA, userAgentData: { platformVersion: "6.1.0" } }),
  macChrome: hinted(MAC_CHROME_UA, "macOS", "26.4.1", chrome),
  macEdge: hinted(MAC_CHROME_UA, "macOS", "26.4.1", edge),
  macBraveOld: hinted(MAC_CHROME_UA, "macOS", "14.6", brave),
  macSafari: safari("26.4"),
  macSafariOld: safari("26.0"),
  macFirefox: macFirefox("153.0"),
  macFirefoxOld: macFirefox("139.0"),
  windowsChrome: hinted(WINDOWS_CHROME_UA, "Windows", "15.0.0", chrome),
  /** Windows Chrome without Client Hints: phone creation, still on Windows. */
  windowsChromeUnhinted: parseUserAgent({ userAgent: WINDOWS_CHROME_UA }),
  windowsEdge: hinted(WINDOWS_CHROME_UA, "Windows", "15.0.0", edge),
  windowsBrave: hinted(WINDOWS_CHROME_UA, "Windows", "15.0.0", brave),
  windowsFirefox: parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA }),
  linuxChrome: hinted(LINUX_CHROME_UA, "Linux", "", chrome),
  linuxEdge: hinted(LINUX_CHROME_UA, "Linux", "", edge),
  linuxFirefox: parseUserAgent({ userAgent: LINUX_FIREFOX_UA }),
}

/** The Firefox rows as they read once a gate admits them. */
const FIREFOX_ADMITTED: Withdrawn = { ...WITHDRAWN, windowsFirefox: [], linuxFirefox: [] }

const appleRefused = (ua: UserAgentInfo): LaptopCreation =>
  withoutManager(laptopCreationFor(ua, FIREFOX_ADMITTED), "apple")

/** The sheet for a browser as it reads itself, with its own row unless one is given. */
function sheet(ua: UserAgentInfo, input: Partial<SignUpOptionsInput> = {}): SignUpOptions {
  return signUpOptionsFor({
    creation: laptopCreationFor(ua, FIREFOX_ADMITTED),
    reach: "ok",
    extension: "none",
    refusedOften: false,
    ignoresHints: ignoresHintsFor(ua),
    os: ua.osFamily,
    ...input,
  })
}

const ids = (s: SignUpOptions) => s.options.map((o) => o.id)
const option = (s: SignUpOptions, id: SignUpChoice) => {
  const found = s.options.find((o) => o.id === id)
  if (!found) throw new Error(`no ${id} in ${ids(s).join(", ")}`)
  return found
}

const L = PHONE_STEPS_COPY.local
const C = SIGN_UP_SHEET_COPY

type Row = {
  name: string
  ua: UserAgentInfo
  creation?: LaptopCreation
  extension: PasskeyExtension
  options: SignUpChoice[]
  selected: SignUpChoice
  line?: "install-extension"
}

/** The options table, with no refusals past the limit. */
const both = (
  name: string,
  ua: UserAgentInfo,
  without: Omit<Row, "name" | "ua" | "extension">,
  withExtension: Omit<Row, "name" | "ua" | "extension">,
  creation?: LaptopCreation,
): Row[] => [
  { name, ua, extension: "none", ...without, ...(creation ? { creation } : {}) },
  { name, ua, extension: "1password", ...withExtension, ...(creation ? { creation } : {}) },
]

const TABLE: Row[] = [
  ...both(
    "ChromeOS Chrome",
    UA.chromeOs,
    { options: ["phone", "key"], selected: "phone" },
    { options: ["phone", "key"], selected: "phone" },
  ),
  ...[UA.macSafariOld, UA.macFirefoxOld].flatMap((ua) =>
    both(
      `Mac ${ua.browserFamily} below its label floor`,
      ua,
      { options: ["phone-or-key"], selected: "phone-or-key" },
      { options: ["phone-or-key"], selected: "phone-or-key" },
    ),
  ),
  ...[UA.windowsFirefox, UA.linuxFirefox].flatMap((ua) =>
    both(
      `${ua.osFamily} Firefox`,
      ua,
      { options: ["phone-or-key"], selected: "phone-or-key", line: "install-extension" },
      { options: ["1password", "phone-or-key"], selected: "1password" },
    ),
  ),
  ...[UA.windowsEdge, UA.windowsBrave, UA.linuxEdge].flatMap((ua) =>
    both(
      `${ua.osFamily} ${ua.browserFamily}`,
      ua,
      { options: ["phone", "key"], selected: "phone", line: "install-extension" },
      { options: ["1password", "phone", "key"], selected: "1password" },
    ),
  ),
  ...[UA.windowsChrome, UA.linuxChrome, UA.macChrome, UA.macEdge].flatMap((ua) =>
    both(
      `${ua.osFamily} ${ua.browserFamily}`,
      ua,
      { options: ["computer", "phone", "key"], selected: "computer" },
      { options: ["1password", "computer", "phone", "key"], selected: "1password" },
    ),
  ),
  ...both(
    "Mac Chrome after an Apple refusal",
    UA.macChrome,
    { options: ["computer", "phone", "key"], selected: "computer" },
    { options: ["1password", "computer", "phone", "key"], selected: "1password" },
    appleRefused(UA.macChrome),
  ),
  ...both(
    "Mac Brave below macOS 15",
    UA.macBraveOld,
    { options: ["computer", "phone", "key"], selected: "phone" },
    { options: ["1password", "phone", "key"], selected: "1password" },
  ),
  ...both(
    "Mac Edge after an Apple refusal",
    UA.macEdge,
    { options: ["computer", "phone", "key"], selected: "phone" },
    { options: ["1password", "phone", "key"], selected: "1password" },
    appleRefused(UA.macEdge),
  ),
  ...both(
    "Mac Safari 26.4",
    UA.macSafari,
    { options: ["computer", "phone-or-key"], selected: "computer" },
    { options: ["1password", "computer", "phone-or-key"], selected: "1password" },
  ),
  ...both(
    "Mac Safari after an Apple refusal",
    UA.macSafari,
    { options: ["computer", "phone-or-key"], selected: "phone-or-key" },
    { options: ["1password", "phone-or-key"], selected: "1password" },
    appleRefused(UA.macSafari),
  ),
  ...both(
    "Mac Firefox 153",
    UA.macFirefox,
    { options: ["computer", "phone-or-key"], selected: "computer" },
    { options: ["computer", "phone-or-key"], selected: "computer" },
  ),
  ...both(
    "Mac Firefox after an Apple refusal",
    UA.macFirefox,
    { options: ["computer", "phone-or-key"], selected: "phone-or-key" },
    { options: ["computer", "phone-or-key"], selected: "phone-or-key" },
    appleRefused(UA.macFirefox),
  ),
]

const rowSheet = (row: Row, reach: PhoneReach) =>
  sheet(row.ua, {
    extension: row.extension,
    reach,
    ...(row.creation ? { creation: row.creation } : {}),
  })

describe("signUpOptionsFor", () => {
  it.each(TABLE)("$name, extension $extension: $options, opens on $selected", (row) => {
    const s = rowSheet(row, "ok")
    expect(ids(s)).toEqual(row.options)
    expect(s.selected).toBe(row.selected)
    expect(s.line?.kind).toBe(row.line)
  })

  it.each(TABLE)("$name, extension $extension: no phone drops the phone and keeps a key", (row) => {
    const noPhone = (id: SignUpChoice): SignUpChoice[] =>
      id === "phone" ? [] : id === "phone-or-key" ? ["key"] : [id]
    const s = rowSheet(row, "no-hybrid")
    expect(ids(s)).toEqual(row.options.flatMap(noPhone))
    expect(s.selected).toBe(noPhone(row.selected)[0] ?? "key")
  })

  it.each(TABLE)("$name, extension $extension: an unknown reach keeps the phone", (row) => {
    const s = rowSheet(row, "unknown")
    expect(ids(s)).toEqual(row.options)
    expect(s.selected).toBe(row.selected)
  })

  it("on Windows Firefox offers one card and the install line, or 1Password beside it with an extension", () => {
    const without = sheet(UA.windowsFirefox)
    expect(ids(without)).toEqual(["phone-or-key"])
    expect(without.line).toEqual({ kind: "install-extension", text: L.installExtension })
    const withExtension = sheet(UA.windowsFirefox, { extension: "1password" })
    expect(withExtension.selected).toBe("1password")
    expect(withExtension.line).toBeUndefined()
  })

  it("splits 1Password from this computer's own managers", () => {
    const s = sheet(UA.macChrome, { extension: "1password" })
    expect(s.selected).toBe("1password")
    const onePassword = option(s, "1password")
    expect(onePassword.label).toBe("1Password")
    expect(onePassword.description).toBe(C.onePassword.description)
    const computer = option(s, "computer")
    expect(computer.label).toBe("This Mac")
    expect(computer.description).toBe("Saved in iCloud Keychain or Google Password Manager")
    expect(computer.description).not.toContain("1Password")
    expect(computer.supported).toEqual(["iCloud Keychain", "Google Password Manager"])
    expect(option(sheet(UA.windowsChrome), "computer")).toMatchObject({
      label: "This computer",
      description: "Saved in Google Password Manager",
      supported: ["Google Password Manager"],
    })
  })

  it("names 1Password under This Mac where no 1Password option stands beside it", () => {
    const rows = [
      sheet(UA.macSafari),
      sheet(UA.macFirefox),
      sheet(UA.macFirefox, { extension: "1password" }),
    ]
    for (const s of rows) {
      expect(ids(s)).not.toContain("1password")
      expect(option(s, "computer")).toMatchObject({
        description: "Saved in iCloud Keychain or 1Password",
        supported: ["iCloud Keychain", "1Password"],
      })
    }
    expect(option(sheet(UA.macChrome), "computer").description).toBe(
      "Saved in iCloud Keychain, Google Password Manager or 1Password",
    )
    expect(option(sheet(UA.macSafari, { extension: "1password" }), "computer").description).toBe(
      "Saved in iCloud Keychain",
    )
  })

  it("names only the managers left after an Apple refusal", () => {
    const chromeRow = sheet(UA.macChrome, { creation: appleRefused(UA.macChrome) })
    expect(option(chromeRow, "computer").description).toBe(
      "Saved in Google Password Manager or 1Password",
    )
    const edgeRow = sheet(UA.macEdge, {
      creation: appleRefused(UA.macEdge),
      extension: "1password",
    })
    expect(ids(edgeRow)).not.toContain("computer")
  })

  it("offers a Mac with 1Password alone the Mac's passkey window where no extension answers it", () => {
    const rows = [
      sheet(UA.macBraveOld),
      sheet(UA.macEdge, { creation: appleRefused(UA.macEdge) }),
      sheet(UA.macSafari, { creation: appleRefused(UA.macSafari) }),
      sheet(UA.macFirefox, { creation: appleRefused(UA.macFirefox) }),
      sheet(UA.macFirefox, { creation: appleRefused(UA.macFirefox), extension: "1password" }),
    ]
    for (const s of rows) {
      expect(ids(s)).not.toContain("1password")
      expect(s.selected).not.toBe("computer")
      expect(option(s, "computer")).toEqual({
        id: "computer",
        label: "This Mac",
        description: C.computer.macWindow,
        advice: [L.pickOnePassword, L.noOnePasswordHere],
        supported: ["1Password"],
      })
    }
    expect(rows[0]!.selected).toBe("phone")
    expect(rows[2]!.selected).toBe("phone-or-key")
    expect(rows[3]!.selected).toBe("phone-or-key")
    expect(rows[4]!.selected).toBe("phone-or-key")
    // With no phone to send the user to, the second line goes.
    const noPhone = sheet(UA.macSafari, {
      creation: appleRefused(UA.macSafari),
      reach: "no-hybrid",
    })
    expect(option(noPhone, "computer").advice).toEqual([L.pickOnePassword])
  })

  it("offers 1Password on Firefox's Mac row through the Mac's window alone until its extension is lifted", () => {
    const withExtension = sheet(UA.macFirefox, { extension: "1password" })
    expect(ids(withExtension)).toEqual(["computer", "phone-or-key"])
    expect(option(withExtension, "computer").description).toBe(
      "Saved in iCloud Keychain or 1Password",
    )
    const { extensionWithdrawn: _, ...lifted } = laptopCreationFor(UA.macFirefox) as LocalCreation
    expect(ids(sheet(UA.macFirefox, { creation: lifted, extension: "1password" }))).toEqual([
      "1password",
      "computer",
      "phone-or-key",
    ])
  })

  it("offers nothing local on Windows Edge with no extension, and says to install it", () => {
    const s = sheet(UA.windowsEdge)
    expect(ids(s)).toEqual(["phone", "key"])
    expect(s.line).toEqual({ kind: "install-extension", text: L.installExtension })
  })

  it("gives this computer the extension, install and refused-often advice", () => {
    expect(option(sheet(UA.macChrome), "computer").advice).toEqual([])
    expect(option(sheet(UA.windowsChrome), "computer").advice).toEqual([L.installExtension])
    expect(option(sheet(UA.linuxChrome), "computer").advice).toEqual([L.installExtension])
    expect(option(sheet(UA.macChrome, { extension: "1password" }), "computer").advice).toEqual([
      L.extension,
    ])
    expect(option(sheet(UA.macFirefox, { extension: "1password" }), "computer").advice).toEqual([
      L.extension,
    ])
  })

  describe("past the refusal limit", () => {
    const over = { extension: "1password" as const, refusedOften: true }

    it("opens on this computer where the row has its own manager, with the refused-often advice", () => {
      for (const ua of [UA.windowsChrome, UA.macChrome, UA.macSafari, UA.macFirefox]) {
        const s = sheet(ua, over)
        expect(s.selected).toBe("computer")
        expect(option(s, "computer").advice).toEqual([L.extension, L.refusedOften])
        expect(s.line).toBeUndefined()
      }
    })

    it("opens on the phone, or the key with no phone, where 1Password is the row's only manager", () => {
      const steeredPhone = { kind: "steered", text: L.steered.phone }
      const steeredKey = { kind: "steered", text: L.steered.key }
      for (const preferred of [undefined, "1password", "computer"] as const) {
        const input = { ...over, ...(preferred ? { preferred } : {}) }
        expect(sheet(UA.windowsEdge, input)).toMatchObject({
          selected: "phone",
          line: steeredPhone,
        })
        expect(sheet(UA.windowsFirefox, input)).toMatchObject({
          selected: "phone-or-key",
          line: steeredPhone,
        })
        for (const ua of [UA.windowsEdge, UA.windowsFirefox]) {
          expect(sheet(ua, { ...input, reach: "no-hybrid" })).toMatchObject({
            selected: "key",
            line: steeredKey,
          })
        }
      }
    })

    it("keeps 1Password after a closed prompt, with the unfinished line and no steering", () => {
      for (const ua of [UA.windowsEdge, UA.windowsFirefox]) {
        expect(sheet(ua, { ...over, preferred: "1password", unfinished: true })).toEqual(
          expect.objectContaining({
            selected: "1password",
            line: { kind: "unfinished", text: L.unfinished },
          }),
        )
      }
    })

    it("keeps a phone or key preference, with no steered line", () => {
      const kept: [UserAgentInfo, SignUpChoice][] = [
        [UA.windowsEdge, "phone"],
        [UA.windowsEdge, "key"],
        [UA.windowsChrome, "phone"],
        [UA.windowsFirefox, "phone-or-key"],
      ]
      for (const [ua, preferred] of kept) {
        const s = sheet(ua, { ...over, preferred })
        expect(s.selected).toBe(preferred)
        expect(s.line).toBeUndefined()
      }
    })

    it("steers nothing on a row with no local creation", () => {
      expect(sheet(UA.chromeOs, over)).toEqual(expect.objectContaining({ selected: "phone" }))
      expect(sheet(UA.chromeOs, over).line).toBeUndefined()
    })
  })

  describe("a preferred option", () => {
    it("lands on its nearest offered option", () => {
      const cases: [UserAgentInfo, Partial<SignUpOptionsInput>, SignUpChoice][] = [
        [UA.windowsFirefox, { preferred: "phone" }, "phone-or-key"],
        [UA.windowsChrome, { preferred: "phone-or-key" }, "phone"],
        [UA.macSafari, { preferred: "key" }, "phone-or-key"],
        [UA.windowsChrome, { preferred: "1password" }, "computer"],
        [UA.windowsChrome, { preferred: "key" }, "key"],
        [UA.macChrome, { preferred: "computer", extension: "1password" }, "computer"],
      ]
      for (const [ua, input, selected] of cases) expect(sheet(ua, input).selected).toBe(selected)
      expect(
        sheet(UA.macSafari, {
          creation: appleRefused(UA.macSafari),
          extension: "1password",
          preferred: "computer",
        }).selected,
      ).toBe("1password")
    })

    it("lands a lost phone on the key, not on this computer", () => {
      expect(sheet(UA.windowsChrome, { reach: "no-hybrid", preferred: "phone" })).toMatchObject({
        options: [{ id: "computer" }, { id: "key" }],
        selected: "key",
      })
      expect(sheet(UA.macSafari, { reach: "no-hybrid", preferred: "phone-or-key" })).toMatchObject({
        options: [{ id: "computer" }, { id: "key" }],
        selected: "key",
      })
    })

    it("falls through to the defaults when nothing local is left", () => {
      expect(sheet(UA.windowsEdge, { preferred: "computer" }).selected).toBe("phone")
      expect(sheet(UA.chromeOs, { preferred: "1password" }).selected).toBe("phone")
    })
  })

  it("lists exactly what each option saves in", () => {
    const supported = (s: SignUpOptions, id: SignUpChoice) => option(s, id).supported
    const windowsChrome = sheet(UA.windowsChrome, { extension: "1password" })
    expect(supported(windowsChrome, "computer")).toEqual(["Google Password Manager"])
    expect(supported(windowsChrome, "1password")).toEqual(["1Password"])
    expect(supported(windowsChrome, "phone")).toEqual([
      "iCloud Keychain",
      "Google Password Manager",
      "1Password",
    ])
    expect(supported(windowsChrome, "key")).toEqual(["YubiKey 5 security key"])
    expect(supported(sheet(UA.macChrome, { extension: "1password" }), "computer")).toEqual([
      "iCloud Keychain",
      "Google Password Manager",
    ])
    expect(supported(sheet(UA.macChrome), "computer")).toEqual([
      "iCloud Keychain",
      "Google Password Manager",
      "1Password",
    ])
    expect(supported(sheet(UA.macSafari), "computer")).toEqual(["iCloud Keychain", "1Password"])
    expect(supported(sheet(UA.windowsFirefox), "phone-or-key")).toEqual([
      "iCloud Keychain",
      "Google Password Manager",
      "1Password",
      "YubiKey 5 security key",
    ])
  })

  describe("the key with no phone", () => {
    it("says only that this computer can't reach a phone while local options remain", () => {
      for (const ua of [UA.windowsChrome, UA.macSafari]) {
        const key = option(sheet(ua, { reach: "no-hybrid" }), "key")
        expect(key.advice).toEqual([C.key.noPhone])
        expect(key.advice).not.toContain(PHONE_STEPS_COPY.noPhone.caption)
      }
    })

    it("carries the full caption where it is the only option", () => {
      for (const ua of [UA.chromeOs, UA.macSafariOld, UA.windowsEdge, UA.windowsFirefox]) {
        const s = sheet(ua, { reach: "no-hybrid" })
        expect(ids(s)).toEqual(["key"])
        expect(option(s, "key").advice).toEqual([PHONE_STEPS_COPY.noPhone.caption])
      }
    })
  })

  it("names Windows' own choices on the phone options", () => {
    expect(option(sheet(UA.windowsFirefox), "phone-or-key").advice).toEqual([C.phoneOrKey.windows])
    expect(option(sheet(UA.windowsChrome), "phone").advice).toEqual([PHONE_HELP_COPY.windows])
    expect(option(sheet(UA.windowsChromeUnhinted), "phone").advice).toEqual([
      PHONE_HELP_COPY.windows,
    ])
    expect(option(sheet(UA.macChrome), "phone").advice).toEqual([])
    expect(option(sheet(UA.linuxFirefox), "phone-or-key").advice).toEqual([])
    expect(option(sheet(UA.windowsChrome), "key").advice).toEqual([])
  })

  it("tells every cross-device option to pass on an extension's pop-up", () => {
    const s = sheet(UA.windowsChrome, { extension: "1password" })
    expect(option(s, "phone").advice).toEqual([PHONE_HELP_COPY.windows, PHONE_STEPS_COPY.extension])
    expect(option(s, "key").advice).toEqual([PHONE_STEPS_COPY.extension])
    expect(
      option(sheet(UA.windowsFirefox, { extension: "1password" }), "phone-or-key").advice,
    ).toEqual([C.phoneOrKey.windows, PHONE_STEPS_COPY.extension])
  })

  it("warns about keys wherever a key can be picked", () => {
    const chromium = sheet(UA.macChrome, { extension: "1password" })
    expect(option(chromium, "key").keyWarning).toEqual(C.keyWarning)
    for (const id of ["1password", "computer", "phone"] as const) {
      expect(option(chromium, id).keyWarning).toBeUndefined()
    }
    expect(option(sheet(UA.macSafari), "phone-or-key").keyWarning).toEqual(C.keyWarning)
    expect(C.keyWarning).toEqual({
      label: "About security keys",
      note: PHONE_STEPS_COPY.noPhone.note,
      models: PHONE_STEPS_COPY.noPhone.models,
    })
  })

  it("the 1Password option carries no advice, whatever else is offered", () => {
    const advice = (ua: UserAgentInfo, reach: PhoneReach = "ok") =>
      option(sheet(ua, { extension: "1password", reach }), "1password").advice
    expect(advice(UA.macChrome)).toEqual([])
    expect(advice(UA.windowsChrome, "no-hybrid")).toEqual([])
    expect(advice(UA.windowsEdge)).toEqual([])
  })

  describe("a script that is not 1Password's", () => {
    const classes = ["bitwarden", "other"] as const

    it("offers no 1Password option, keeps the dismiss line and drops the install line", () => {
      for (const extension of classes) {
        const chrome = sheet(UA.macChrome, { extension })
        expect(ids(chrome)).toEqual(["computer", "phone", "key"])
        expect(chrome.selected).toBe("computer")
        expect(chrome.line).toBeUndefined()
        expect(option(chrome, "computer")).toMatchObject({
          description: "Saved in iCloud Keychain, Google Password Manager or 1Password",
          advice: [L.extension],
        })
        const edge = sheet(UA.windowsEdge, { extension })
        expect(ids(edge)).toEqual(["phone", "key"])
        expect(edge.selected).toBe("phone")
        expect(edge.line).toBeUndefined()
        expect(option(edge, "phone").advice).toEqual([
          PHONE_HELP_COPY.windows,
          PHONE_STEPS_COPY.extension,
        ])
        const chromeOnWindows = sheet(UA.windowsChrome, { extension })
        expect(ids(chromeOnWindows)).toEqual(["computer", "phone", "key"])
        expect(option(chromeOnWindows, "computer").advice).toEqual([L.extension])
        const firefoxOnWindows = sheet(UA.windowsFirefox, { extension })
        expect(ids(firefoxOnWindows)).toEqual(["phone-or-key"])
        expect(firefoxOnWindows.line).toBeUndefined()
        // The rest of each option reads as it does when 1Password's script answers.
        const chromeAs1Password = sheet(UA.macChrome, { extension: "1password" })
        expect(option(chrome, "computer").supported).toEqual(
          option(sheet(UA.macChrome), "computer").supported,
        )
        expect(option(chrome, "phone")).toEqual(option(chromeAs1Password, "phone"))
        expect(option(chrome, "key")).toEqual(option(chromeAs1Password, "key"))
        expect(option(edge, "key")).toEqual(
          option(sheet(UA.windowsEdge, { extension: "1password" }), "key"),
        )
        expect(option(firefoxOnWindows, "phone-or-key")).toEqual(
          option(sheet(UA.windowsFirefox, { extension: "1password" }), "phone-or-key"),
        )
      }
    })

    it("keeps a phone or key preference on every class", () => {
      for (const extension of ["none", "1password", "bitwarden", "other"] as const) {
        expect(sheet(UA.macChrome, { extension, preferred: "phone" }).selected).toBe("phone")
        expect(sheet(UA.macChrome, { extension, preferred: "key" }).selected).toBe("key")
        expect(sheet(UA.windowsEdge, { extension, preferred: "key" }).selected).toBe("key")
        expect(sheet(UA.macFirefox, { extension, preferred: "phone" }).selected).toBe(
          "phone-or-key",
        )
      }
    })

    it("adds the dismiss line to the Mac's window option", () => {
      for (const extension of classes) {
        const s = sheet(UA.macFirefox, { creation: appleRefused(UA.macFirefox), extension })
        expect(ids(s)).toEqual(["computer", "phone-or-key"])
        expect(s.selected).toBe("phone-or-key")
        expect(s.line).toBeUndefined()
        expect(s.warning).toBe(C.extensionWarning)
        expect(option(s, "computer")).toMatchObject({
          description: C.computer.macWindow,
          supported: ["1Password"],
          advice: [L.pickOnePassword, L.noOnePasswordHere, L.extension],
        })
        expect(option(s, "phone-or-key")).toEqual(
          option(
            sheet(UA.macFirefox, { creation: appleRefused(UA.macFirefox), extension: "1password" }),
            "phone-or-key",
          ),
        )
        const noPhone = sheet(UA.macFirefox, {
          creation: appleRefused(UA.macFirefox),
          extension,
          reach: "no-hybrid",
        })
        expect(ids(noPhone)).toEqual(["computer", "key"])
        expect(option(noPhone, "computer").advice).toEqual([L.pickOnePassword, L.extension])
        for (const preferred of ["computer", "1password"] as const) {
          expect(
            sheet(UA.macFirefox, { creation: appleRefused(UA.macFirefox), extension, preferred })
              .selected,
          ).toBe("computer")
        }
      }
    })

    it("keeps the refusal-limit steering and the unfinished line", () => {
      for (const extension of classes) {
        const over = { extension, refusedOften: true }
        const chrome = sheet(UA.macChrome, over)
        expect(chrome.selected).toBe("computer")
        expect(option(chrome, "computer").advice).toEqual([L.extension, L.refusedOften])
        expect(sheet(UA.windowsEdge, over)).toMatchObject({
          selected: "phone",
          line: { kind: "steered", text: L.steered.phone },
        })
        expect(sheet(UA.windowsEdge, { extension, unfinished: true }).line).toEqual({
          kind: "unfinished",
          text: L.unfinished,
        })
        expect(sheet(UA.macChrome, { extension, preferred: "1password" }).selected).toBe("computer")
        expect(sheet(UA.windowsEdge, { extension, preferred: "1password" }).selected).toBe("phone")
      }
    })

    it("carries the warning for the running sheet, and nothing else does", () => {
      for (const extension of classes) {
        expect(sheet(UA.macChrome, { extension }).warning).toBe(C.extensionWarning)
        expect(sheet(UA.windowsEdge, { extension }).warning).toBe(C.extensionWarning)
      }
      for (const extension of ["none", "1password"] as const) {
        expect(sheet(UA.macChrome, { extension })).not.toHaveProperty("warning")
        expect(sheet(UA.windowsEdge, { extension })).not.toHaveProperty("warning")
      }
    })
  })

  it("shows the unfinished line over any other", () => {
    const s = sheet(UA.windowsEdge, { preferred: "1password", unfinished: true })
    expect(s.selected).toBe("phone")
    expect(s.line).toEqual({ kind: "unfinished", text: L.unfinished })
  })

  it("draws every option with a label and a description", () => {
    for (const row of TABLE) {
      for (const o of rowSheet(row, "ok").options) {
        expect(o.label).not.toBe("")
        expect(o.description).not.toBe("")
      }
    }
  })
})

describe("routeForChoice", () => {
  it("sends this computer's options locally, the phone's to a phone, the key to a key", () => {
    expect(routeForChoice("computer")).toBe("this-device")
    expect(routeForChoice("1password")).toBe("this-device")
    expect(routeForChoice("phone")).toBe("phone")
    expect(routeForChoice("phone-or-key")).toBe("phone")
    expect(routeForChoice("key")).toBe("security-key")
  })
})

describe("ignoresHintsFor", () => {
  it("is Safari and Firefox", () => {
    for (const ua of [UA.macSafari, UA.macFirefox, UA.windowsFirefox, UA.linuxFirefox]) {
      expect(ignoresHintsFor(ua)).toBe(true)
    }
    for (const ua of [UA.macChrome, UA.macEdge, UA.windowsBrave, UA.chromeOs]) {
      expect(ignoresHintsFor(ua)).toBe(false)
    }
  })
})
