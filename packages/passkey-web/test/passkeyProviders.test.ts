import {
  APPLE_ICLOUD_AAGUID,
  GPM_AAGUID,
  ONEPASSWORD_AAGUID,
  SECURITY_KEY_AAGUIDS,
  YUBIKEY_5_NFC_AAGUID,
  ZERO_AAGUID,
} from "@obsidion/core/constants"
import { describe, expect, it } from "vitest"
import {
  CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID,
  PASSKEY_MANAGER_AAGUIDS,
  providerAllowed,
  providerNameFor,
  providerSlugFor,
  refusalKindFor,
} from "../src/policy/passkeyProviders.js"

const BITWARDEN = "d548826e-79b4-db40-a3d8-11116f7e8349"
const WINDOWS_HELLO = "08987058-cadc-4b81-b6e1-30de50dcbe96"
const UNMEASURED = "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f"
const A_KEY = [...SECURITY_KEY_AAGUIDS][0]!

describe("providerAllowed", () => {
  it("admits every measured manager to a phone passkey", () => {
    for (const id of [APPLE_ICLOUD_AAGUID, GPM_AAGUID, ONEPASSWORD_AAGUID]) {
      expect(providerAllowed(id, false)).toBe(true)
    }
    expect(providerAllowed(APPLE_ICLOUD_AAGUID.toUpperCase(), false)).toBe(true)
  })

  it("admits every measured security key to a key", () => {
    for (const id of SECURITY_KEY_AAGUIDS) expect(providerAllowed(id, true)).toBe(true)
  })

  it("admits an absent or all-zero id to either class", () => {
    for (const securityKey of [true, false]) {
      expect(providerAllowed(undefined, securityKey)).toBe(true)
      expect(providerAllowed(ZERO_AAGUID, securityKey)).toBe(true)
    }
  })

  it("refuses an id that contradicts the class that answered", () => {
    // A manager id on a hardware key, or a key's id on a phone passkey: one of the two is lying.
    expect(providerAllowed(GPM_AAGUID, true)).toBe(false)
    expect(providerAllowed(A_KEY, false)).toBe(false)
  })

  it("refuses an unmeasured provider to either class", () => {
    for (const securityKey of [true, false]) {
      expect(providerAllowed(BITWARDEN, securityKey)).toBe(false)
      expect(providerAllowed(UNMEASURED, securityKey)).toBe(false)
    }
  })

  it("admits an id the caller lists on top of the measured set", () => {
    const extra = [CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID]
    expect(providerAllowed(CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID, false)).toBe(false)
    expect(providerAllowed(CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID, false, extra)).toBe(true)
    expect(providerAllowed(CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID, true, extra)).toBe(true)
    expect(providerAllowed(UNMEASURED, false, extra)).toBe(false)
    // Ids arrive from a parser that emits lowercase, but a caller's list is hand-written.
    expect(providerAllowed(UNMEASURED, false, [UNMEASURED.toUpperCase()])).toBe(true)
  })
})

describe("refusalKindFor", () => {
  it("follows the class when the class is certain", () => {
    expect(refusalKindFor(undefined, true)).toBe("security-key")
    expect(refusalKindFor(BITWARDEN, false)).toBe("manager")
  })

  it("follows the id when a key was named but its transports were withheld", () => {
    // Classed as a phone (no transports) but the orphan is on the key, so the key's advice wins.
    expect(refusalKindFor(A_KEY, false)).toBe("security-key")
    expect(refusalKindFor(A_KEY.toUpperCase(), false)).toBe("security-key")
  })
})

describe("providerNameFor", () => {
  it("names a provider it knows, so a refusal can say which", () => {
    expect(providerNameFor(BITWARDEN)).toBe("Bitwarden")
    expect(providerNameFor(GPM_AAGUID)).toBe("Google Password Manager")
  })

  it("never invents a name for an id it does not know, nor for zeros", () => {
    expect(providerNameFor(UNMEASURED)).toBeUndefined()
    expect(providerNameFor(ZERO_AAGUID)).toBeUndefined()
    expect(providerNameFor(undefined)).toBeUndefined()
  })

  it("can name everything it admits", () => {
    for (const id of [...PASSKEY_MANAGER_AAGUIDS, ...SECURITY_KEY_AAGUIDS]) {
      expect(providerNameFor(id)).toBeTruthy()
    }
  })

  it("keeps every name it gave", () => {
    expect(
      Object.fromEntries(
        [
          "adce0002-35bc-c60a-648b-0b25f1f05503",
          APPLE_ICLOUD_AAGUID,
          "dd4ec289-e01d-41c9-bb89-70fa845d4bf2",
          GPM_AAGUID,
          WINDOWS_HELLO,
          ONEPASSWORD_AAGUID,
          BITWARDEN,
          YUBIKEY_5_NFC_AAGUID,
          "f8a011f3-8c0a-4d15-8006-17111f9edc7d",
          "531126d6-e717-415c-9320-3d9aa6981239",
          "50726f74-6f6e-5061-7373-50726f746f6e",
          "53414d53-554e-4700-0000-000000000000",
        ].map((id) => [id, providerNameFor(id)]),
      ),
    ).toEqual({
      "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome",
      [APPLE_ICLOUD_AAGUID]: "iCloud Keychain",
      "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain (managed)",
      [GPM_AAGUID]: "Google Password Manager",
      [WINDOWS_HELLO]: "Windows Hello",
      [ONEPASSWORD_AAGUID]: "1Password",
      [BITWARDEN]: "Bitwarden",
      [YUBIKEY_5_NFC_AAGUID]: "YubiKey 5 NFC",
      "f8a011f3-8c0a-4d15-8006-17111f9edc7d": "Security Key by Yubico",
      "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
      "50726f74-6f6e-5061-7373-50726f746f6e": "Proton Pass",
      "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
    })
  })
})

describe("providerSlugFor", () => {
  it("counts each named provider under its slug", () => {
    expect(providerSlugFor(APPLE_ICLOUD_AAGUID)).toBe("icloud_keychain")
    expect(providerSlugFor(APPLE_ICLOUD_AAGUID.toUpperCase())).toBe("icloud_keychain")
    expect(providerSlugFor(GPM_AAGUID)).toBe("google_password_manager")
    expect(providerSlugFor(ONEPASSWORD_AAGUID)).toBe("1password")
    expect(providerSlugFor(WINDOWS_HELLO)).toBe("windows_hello")
    expect(providerSlugFor(BITWARDEN)).toBe("bitwarden")
    expect(providerSlugFor("adce0002-35bc-c60a-648b-0b25f1f05503")).toBe("chrome_profile")
  })

  it("counts every measured security key as a YubiKey", () => {
    expect(providerSlugFor(YUBIKEY_5_NFC_AAGUID)).toBe("yubikey")
    for (const id of SECURITY_KEY_AAGUIDS) expect(providerSlugFor(id)).toBe("yubikey")
  })

  it("tells a provider that did not report itself from one that said nothing", () => {
    expect(providerSlugFor(ZERO_AAGUID)).toBe("not_reported")
    expect(providerSlugFor(undefined)).toBe("unknown")
    expect(providerSlugFor("")).toBe("unknown")
    expect(providerSlugFor("unknown")).toBe("unknown")
    expect(providerSlugFor("not-a-uuid")).toBe("unknown")
    expect(providerSlugFor("constructor")).toBe("unknown")
    expect(providerSlugFor(42 as unknown as string)).toBe("unknown")
  })

  it("counts an id it cannot name as another provider", () => {
    expect(providerSlugFor(UNMEASURED)).toBe("other")
    expect(providerSlugFor(CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID)).toBe("other")
  })
})
