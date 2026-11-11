// @vitest-environment node
/** The Passkeys sheet's backup options, from the page's own reads of its browser. */
import { KEPT_PASSKEY_API_KEY, SIGN_UP_SHEET_COPY } from "@obsidion/passkey-web"
import { afterEach, describe, expect, it, vi } from "vitest"
import { backupAddSheetOptions } from "../../../src/features/backupPasskey/backupAddOptions"
import { nativeCreate, onePasswordCreate } from "../../support/passkeyExtensionStubs"

const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const WINDOWS_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"

const browser = (userAgent: string, create: unknown = nativeCreate) =>
  vi.stubGlobal("navigator", { userAgent, credentials: { create } })
const ids = (reach: "unknown" | "no-hybrid" = "unknown") =>
  backupAddSheetOptions({ reach }).options.map((o) => o.id)

afterEach(() => vi.unstubAllGlobals())

describe("backupAddSheetOptions", () => {
  it("offers 1Password where its script answers the page, still opening on the phone", () => {
    browser(MAC_CHROME_UA, onePasswordCreate())
    expect(ids()).toEqual(["phone", "key", "1password", "computer"])
    expect(backupAddSheetOptions({ reach: "unknown" }).selected).toBe("phone")
  })

  it("offers Proton Pass where the page-start lock kept its wrapper", () => {
    browser(MAC_CHROME_UA)
    vi.stubGlobal(KEPT_PASSKEY_API_KEY, { create: () => null })
    expect(ids()).toEqual(["phone", "key", "proton", "computer"])
  })

  it("lists this computer last, labeled for a Mac, with no extension or kept wrapper", () => {
    browser(MAC_CHROME_UA)
    const { options, selected } = backupAddSheetOptions({ reach: "unknown" })
    expect(selected).toBe("phone")
    expect(options.at(-1)?.label).toBe(SIGN_UP_SHEET_COPY.computer.macLabel)
    expect(options.map((o) => o.id)).not.toContain("1password")
  })

  it("merges phone and key where the browser ignores hints, as every browser on Windows does", () => {
    browser(WINDOWS_CHROME_UA)
    expect(ids()).toEqual(["phone-or-key", "computer"])
    browser(MAC_CHROME_UA)
    expect(ids()).toEqual(["phone", "key", "computer"])
  })

  it("offers no phone where the probe found no hybrid transport", () => {
    browser(MAC_CHROME_UA)
    expect(ids("no-hybrid")).toEqual(["key", "computer"])
  })
})
