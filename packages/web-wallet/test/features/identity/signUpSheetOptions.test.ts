// @vitest-environment node
/** The laptop sign-up sheet's options, from the probes and the page's own reads of its browser. */
import { KEPT_PASSKEY_API_KEY, PHONE_STEPS_COPY, type LaptopCreation } from "@obsidion/passkey-web"
import { afterEach, describe, expect, it, vi } from "vitest"
import { signUpSheetOptions } from "../../../src/features/identity/signUpSheetOptions"
import { LOCAL_REFUSAL_LIMIT } from "../../../src/platform/auth/localRefusals"
import { nativeCreate, onePasswordCreate } from "../../support/passkeyExtensionStubs"

const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const WINDOWS_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"

const WINDOWS: LaptopCreation = {
  local: true,
  os: "windows",
  row: "windowsChrome",
  managers: ["gpm", "1password"],
  withdrawn: [],
}

const MAC: LaptopCreation = {
  local: true,
  os: "macos",
  row: "macChrome",
  managers: ["apple", "gpm", "1password", "proton"],
  withdrawn: [],
}

const browser = (userAgent: string, create: unknown = nativeCreate) =>
  vi.stubGlobal("navigator", { userAgent, credentials: { create } })
const sheet = (refusals = 0) =>
  signUpSheetOptions({ creation: WINDOWS, reach: "unknown", refusals })
const ids = () => sheet().options.map((o) => o.id)
const advice = (refusals: number) =>
  sheet(refusals).options.find((o) => o.id === "computer")?.advice ?? []

afterEach(() => vi.unstubAllGlobals())

describe("signUpSheetOptions", () => {
  it("offers 1Password only where its script answers the page", () => {
    browser(WINDOWS_CHROME_UA, onePasswordCreate())
    expect(ids()).toContain("1password")
    browser(WINDOWS_CHROME_UA)
    expect(ids()).not.toContain("1password")
  })

  it("says refusals came often only past the limit, and only while an extension answers", () => {
    browser(WINDOWS_CHROME_UA, onePasswordCreate())
    expect(advice(LOCAL_REFUSAL_LIMIT + 1)).toContain(PHONE_STEPS_COPY.local.refusedOften)
    expect(advice(LOCAL_REFUSAL_LIMIT)).not.toContain(PHONE_STEPS_COPY.local.refusedOften)
    browser(WINDOWS_CHROME_UA)
    expect(advice(LOCAL_REFUSAL_LIMIT + 1)).not.toContain(PHONE_STEPS_COPY.local.refusedOften)
  })

  it("opens on Proton Pass, with its tip, only where the page-start lock kept its wrapper", () => {
    browser(MAC_CHROME_UA)
    const mac = () => signUpSheetOptions({ creation: MAC, reach: "ok", refusals: 0 })
    vi.stubGlobal(KEPT_PASSKEY_API_KEY, { create: () => Promise.resolve(null) })
    const kept = mac()
    expect(kept.selected).toBe("proton")
    const tips = kept.options.map((o) => [o.id, o.protonWarning !== undefined, o.helloWarning])
    expect(tips).toContainEqual(["proton", true, undefined])
    expect(tips).toContainEqual(["computer", false, undefined])
    vi.unstubAllGlobals()
    browser(MAC_CHROME_UA)
    const lost = mac()
    expect(lost.selected).toBe("computer")
    expect(lost.options.map((o) => o.id)).not.toContain("proton")
  })

  it("merges phone and key where the user agent's browser ignores hints", () => {
    browser(WINDOWS_CHROME_UA)
    expect(ids()).toEqual(["computer", "phone-or-key"])
    browser(MAC_CHROME_UA)
    expect(ids()).toEqual(["computer", "phone", "key"])
  })
})
