// @vitest-environment node
/** The settings sheet's backup picker, built from what the page detected. */
import { describe, expect, it } from "vitest"
import {
  type BackupAddChoice,
  type BackupAddOptions,
  type BackupAddOptionsInput,
  backupAddOptionsFor,
} from "../src/policy/backupAddOptions.js"
import {
  BACKUP_ADD_SHEET_COPY,
  PHONE_STEPS_COPY,
  SIGN_UP_SHEET_COPY,
} from "../src/policy/refusalCopy.js"

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
  it("offers this computer, the phone and the key, and opens on this computer", () => {
    const s = sheet()
    expect(ids(s)).toEqual(["computer", "phone", "key"])
    expect(s.selected).toBe("computer")
    expect(option(s, "computer")).toMatchObject({
      label: C.computer.macLabel,
      description: B.computer.description,
      advice: [],
    })
    expect(option(sheet({ os: "windows" }), "computer").label).toBe(C.computer.label)
    expect(option(sheet({ os: "linux" }), "computer").label).toBe(C.computer.label)
  })

  it.each([
    ["1Password's extension", { extension: "1password" }, "1password"],
    ["Proton Pass's kept wrapper", { protonKept: true }, "proton"],
  ] as const)("lists %s first and opens on it", (_, input, first) => {
    const s = sheet(input)
    expect(ids(s)).toEqual([first, "computer", "phone", "key"])
    expect(s.selected).toBe(first)
  })

  it("with both detected, 1Password comes first and opens, Proton Pass stays offered", () => {
    const s = sheet({ extension: "1password", protonKept: true })
    expect(ids(s)).toEqual(["1password", "proton", "computer", "phone", "key"])
    expect(s.selected).toBe("1password")
    expect(option(s, "1password")).toMatchObject({
      label: C.onePassword.label,
      description: B.onePassword.description,
      advice: [],
    })
    expect(option(s, "proton")).toMatchObject({
      label: B.proton.label,
      description: B.proton.description,
      advice: [],
    })
  })

  it("drops the phone where none can be reached, and says so on the key", () => {
    const s = sheet({ reach: "no-hybrid" })
    expect(ids(s)).toEqual(["computer", "key"])
    expect(option(s, "key").advice).toEqual([C.key.noPhone])
    for (const reach of ["unknown", "below-floor"] as const) {
      expect(ids(sheet({ reach }))).toContain("phone")
    }
  })

  it("merges the phone and the key where the browser ignores hints, with the Windows prompt advice there", () => {
    const mac = sheet({ ignoresHints: true })
    expect(ids(mac)).toEqual(["computer", "phone-or-key"])
    expect(option(mac, "phone-or-key")).toMatchObject({
      label: C.phoneOrKey.label,
      description: C.phoneOrKey.description,
      advice: [B.phone.managers],
    })
    const windows = sheet({ ignoresHints: true, os: "windows" })
    expect(option(windows, "phone-or-key").advice).toEqual([B.phone.managers, C.phoneOrKey.windows])
  })

  it("tells the phone pick which managers a phone may hold the backup in", () => {
    expect(option(sheet(), "phone")).toMatchObject({
      label: C.phone.label,
      description: C.phone.description,
      advice: [B.phone.managers],
    })
    expect(B.phone.managers).toMatch(/iCloud Keychain, Google Password Manager or 1Password/)
  })

  it("warns on every option that can reach a key, in the backup's own words", () => {
    expect(option(sheet(), "key").keyWarning).toBe(B.keyWarning)
    expect(option(sheet({ ignoresHints: true }), "phone-or-key").keyWarning).toBe(B.keyWarning)
    expect(option(sheet(), "phone").keyWarning).toBeUndefined()
    expect(option(sheet(), "computer").keyWarning).toBeUndefined()
    expect(B.keyWarning.label).toBe(C.keyWarning.label)
    expect(B.keyWarning.note).not.toMatch(/second key|lose the wallet/)
    expect(B.keyWarning.note).toMatch(/other passkey still opens/)
  })

  it("warns about a pop-up where a script the page cannot use answers it", () => {
    const s = sheet({ extension: "bitwarden" })
    expect(ids(s)).toEqual(["computer", "phone", "key"])
    expect(option(s, "computer").advice).toEqual([PHONE_STEPS_COPY.local.extension])
    expect(option(s, "phone").advice).toEqual([B.phone.managers, PHONE_STEPS_COPY.extension])
    expect(option(s, "key").advice).toEqual([PHONE_STEPS_COPY.extension])
  })
})
