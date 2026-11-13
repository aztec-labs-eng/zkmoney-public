// @vitest-environment node
/** The settings sheet's backup picker, built from what the page detected. */
import { describe, expect, it } from "vitest"
import {
  type BackupAddChoice,
  type BackupAddOptions,
  type BackupAddOptionsInput,
  backupAddOptionsFor,
} from "../../src/options/backupAddOptions.js"
import {
  BACKUP_ADD_SHEET_COPY,
  PHONE_STEPS_COPY,
  SIGN_UP_SHEET_COPY,
} from "../../src/refusals/refusalCopy.js"

/** A Mac Chrome with nothing detected and a phone in reach, unless told otherwise. */
const sheet = (input: Partial<BackupAddOptionsInput> = {}): BackupAddOptions =>
  backupAddOptionsFor({
    reach: "ok",
    extension: "none",
    protonKept: false,
    ignoresHints: false,
    os: "macos",
    ...input,
  })

const ids = (s: BackupAddOptions) => s.options.map((o) => o.id)
const option = (s: BackupAddOptions, id: BackupAddChoice) => {
  const found = s.options.find((o) => o.id === id)
  if (!found) throw new Error(`no ${id} in ${ids(s).join(", ")}`)
  return found
}

const C = SIGN_UP_SHEET_COPY
const B = BACKUP_ADD_SHEET_COPY

describe("backupAddOptionsFor", () => {
  it("offers the phone, the key and this computer last, and opens on the recommended phone", () => {
    const s = sheet()
    expect(ids(s)).toEqual(["phone", "key", "computer"])
    expect(s.selected).toBe("phone")
    expect(s.options.filter((o) => o.badge === "recommended").map((o) => o.id)).toEqual(["phone"])
    expect(option(s, "computer")).toMatchObject({
      label: C.computer.macLabel,
      description: B.computer.macDescription,
      advice: [],
    })
    expect(option(sheet({ os: "windows" }), "computer")).toMatchObject({
      label: C.computer.label,
      description: B.computer.description,
    })
  })

  it("offers the managers detected before this computer, still opening on the phone", () => {
    expect(ids(sheet({ protonKept: true }))).toEqual(["phone", "key", "proton", "computer"])
    const s = sheet({ extension: "1password", protonKept: true })
    expect(ids(s)).toEqual(["phone", "key", "1password", "proton", "computer"])
    expect(s.selected).toBe("phone")
  })

  it("drops the phone where none can be reached, says so on the key and opens there", () => {
    const s = sheet({ reach: "no-hybrid" })
    expect(ids(s)).toEqual(["key", "computer"])
    expect(s.selected).toBe("key")
    expect(option(s, "key")).toMatchObject({ advice: [C.key.noPhone] })
    expect(s.options.some((o) => o.badge === "recommended")).toBe(false)
    for (const reach of ["unknown", "below-floor"] as const) {
      expect(ids(sheet({ reach }))).toContain("phone")
    }
  })

  it("merges the phone and the key where the browser ignores hints, with the Windows prompt advice there", () => {
    const mac = sheet({ ignoresHints: true })
    expect(ids(mac)).toEqual(["phone-or-key", "computer"])
    expect(mac.selected).toBe("phone-or-key")
    expect(option(mac, "phone-or-key")).toMatchObject({ advice: [], badge: "recommended" })
    const windows = sheet({ ignoresHints: true, os: "windows" })
    expect(option(windows, "phone-or-key").advice).toEqual([C.phoneOrKey.windows])
  })

  it("warns on every option that can reach a key, in the backup's own words", () => {
    expect(option(sheet(), "key").keyWarning).toBe(B.keyWarning)
    expect(option(sheet({ ignoresHints: true }), "phone-or-key").keyWarning).toBe(B.keyWarning)
    expect(option(sheet(), "phone").keyWarning).toBeUndefined()
    expect(option(sheet(), "computer").keyWarning).toBeUndefined()
  })

  it("links the managers on every option that can reach a phone, else on this computer", () => {
    const linked = (s: BackupAddOptions) => s.options.filter((o) => o.managersLink).map((o) => o.id)
    expect(linked(sheet({ extension: "1password", protonKept: true }))).toEqual(["phone"])
    expect(linked(sheet({ ignoresHints: true }))).toEqual(["phone-or-key"])
    expect(linked(sheet({ reach: "no-hybrid", extension: "1password" }))).toEqual(["computer"])
  })

  it("marks only this computer not recommended", () => {
    const s = sheet({ extension: "1password", protonKept: true })
    const discouraged = s.options.filter((o) => o.badge === "notRecommended").map((o) => o.id)
    expect(discouraged).toEqual(["computer"])
    expect(option(sheet({ reach: "no-hybrid" }), "computer").badge).toBe("notRecommended")
  })

  it("warns about a pop-up where a script the page cannot use answers it", () => {
    const s = sheet({ extension: "bitwarden" })
    expect(ids(s)).toEqual(["phone", "key", "computer"])
    expect(option(s, "computer").advice).toEqual([PHONE_STEPS_COPY.local.extension])
    expect(option(s, "phone").advice).toEqual([PHONE_STEPS_COPY.extension])
    expect(option(s, "key").advice).toEqual([PHONE_STEPS_COPY.extension])
  })
})
