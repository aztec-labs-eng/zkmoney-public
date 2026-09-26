import { describe, expect, it } from "vitest"
import {
  checkAssertionRoute,
  checkCreationRoute,
  creationHintsFor,
  offerableTransports,
  hintsFor,
  impliedKeyTransports,
  isPhysicalOnly,
  isSecurityKey,
  requestedAttachment,
  signInHintsFor,
  slotForAttachment,
} from "../src/policy/slotRule.js"

describe("the slot rule", () => {
  it("binds a local answer to second and a cross-device answer to first", () => {
    expect(slotForAttachment("platform")).toBe("second")
    expect(slotForAttachment("cross-platform")).toBe("first")
  })

  it("asks a laptop for a phone's, and asks a phone for nothing so its sheet can offer a key", () => {
    expect(requestedAttachment("laptop")).toBe("cross-platform")
    expect(requestedAttachment("phone")).toBeUndefined()
  })
})

describe("telling a security key from a phone", () => {
  it("takes another device answering over physical transports only", () => {
    for (const transports of [["usb"], ["nfc", "usb"], ["ble"], ["smart-card"]]) {
      expect(isSecurityKey({ authenticatorAttachment: "cross-platform", transports })).toBe(true)
    }
  })

  it("treats anything less certain as a phone, so the backup gate still applies", () => {
    const notKeys = [
      ["hybrid"],
      ["hybrid", "internal"],
      ["usb", "hybrid"],
      ["usb", "internal"],
      // A transport this code has never heard of says nothing about how the answer arrived.
      ["usb", "something-new"],
      ["something-new"],
      [],
    ]
    for (const transports of notKeys) {
      expect(isSecurityKey({ authenticatorAttachment: "cross-platform", transports })).toBe(false)
    }
    expect(
      isSecurityKey({ authenticatorAttachment: "cross-platform", transports: undefined }),
    ).toBe(false)
    expect(isSecurityKey({ authenticatorAttachment: "platform", transports: ["usb"] })).toBe(false)
    expect(isSecurityKey({ transports: ["usb"] })).toBe(false)
  })

  it("a recorded list is physical only when every entry is a physical transport", () => {
    expect(isPhysicalOnly(["usb"])).toBe(true)
    expect(isPhysicalOnly(["usb", "nfc"])).toBe(true)
    for (const list of [
      ["hybrid"],
      ["hybrid", "internal"],
      ["internal"],
      ["usb", "something-new"],
      [],
    ]) {
      expect(isPhysicalOnly(list)).toBe(false)
    }
    expect(isPhysicalOnly(undefined)).toBe(false)
  })
})

describe("what an assertion implies about its authenticator", () => {
  it("another device that cannot be backed up is a key, asked over every physical route but ble", () => {
    expect(
      impliedKeyTransports({ authenticatorAttachment: "cross-platform", backupEligible: false }),
    ).toEqual(["usb", "nfc", "smart-card"])
  })

  it("implies nothing for a synced passkey, a local answer, or an unreadable flag", () => {
    expect(
      impliedKeyTransports({ authenticatorAttachment: "cross-platform", backupEligible: true }),
    ).toBeUndefined()
    expect(
      impliedKeyTransports({ authenticatorAttachment: "platform", backupEligible: false }),
    ).toBeUndefined()
    expect(impliedKeyTransports({ authenticatorAttachment: "cross-platform" })).toBeUndefined()
    expect(impliedKeyTransports({ backupEligible: false })).toBeUndefined()
  })
})

describe("the transports a ceremony offers", () => {
  it("a laptop drops the device's own, which the route rule would refuse anyway", () => {
    expect(offerableTransports("laptop", ["hybrid", "internal"])).toEqual(["hybrid"])
    expect(offerableTransports("laptop", ["usb", "nfc"])).toEqual(["usb", "nfc"])
  })

  it("a phone keeps its own, the only answer it accepts", () => {
    expect(offerableTransports("phone", ["hybrid", "internal"])).toEqual(["hybrid", "internal"])
  })

  it("a laptop record naming nothing else falls back to the cross-device set", () => {
    const crossDevice = ["hybrid", "usb", "nfc", "ble", "smart-card"]
    expect(offerableTransports("laptop", ["internal"])).toEqual(crossDevice)
    expect(offerableTransports("laptop", [])).toEqual(crossDevice)
    expect(offerableTransports("laptop", undefined)).toEqual(crossDevice)
  })

  it("a laptop never offers the device's own, whatever the record holds", () => {
    for (const recorded of [["hybrid", "internal"], ["internal"], [], undefined]) {
      expect(offerableTransports("laptop", recorded)).not.toContain("internal")
    }
  })

  it("a phone with no recorded transports sends nothing", () => {
    expect(offerableTransports("phone", [])).toBeUndefined()
    expect(offerableTransports("phone", undefined)).toBeUndefined()
  })

  it("with the local route allowed, a laptop sends no restriction — even a hybrid-only record can't hide the local copy", () => {
    expect(offerableTransports("laptop", ["hybrid"], true)).toBeUndefined()
    expect(offerableTransports("laptop", ["hybrid", "internal"], true)).toBeUndefined()
    expect(offerableTransports("laptop", undefined, true)).toBeUndefined()
    expect(offerableTransports("laptop", [], true)).toBeUndefined()
  })

  it("with the local route allowed, a hardware key's physical-only list still opens the prompt on the key", () => {
    expect(offerableTransports("laptop", ["usb"], true)).toEqual(["usb"])
    expect(offerableTransports("laptop", ["usb", "nfc"], true)).toEqual(["usb", "nfc"])
    // One non-physical entry makes it a list that could hide the local copy.
    expect(offerableTransports("laptop", ["usb", "hybrid"], true)).toBeUndefined()
  })
})

describe("the creation route rule", () => {
  it("a laptop needs another device, whatever class answered", () => {
    for (const securityKey of [true, false]) {
      expect(() => checkCreationRoute("laptop", "cross-platform", securityKey)).not.toThrow()
    }
    // Each refusal names the device the ceremony was already using.
    expect(() => checkCreationRoute("laptop", "platform", false)).toThrow(
      expect.objectContaining({ name: "PhoneRequiredError" }),
    )
    expect(() => checkCreationRoute("laptop", "platform", true)).toThrow(
      expect.objectContaining({ name: "SecurityKeyRequiredError" }),
    )
  })

  it("a phone takes its own passkey, or a security key, and refuses another phone", () => {
    expect(() => checkCreationRoute("phone", "platform", false)).not.toThrow()
    expect(() => checkCreationRoute("phone", "cross-platform", true)).not.toThrow()
    // Another phone over QR: cross-platform, but not a key.
    expect(() => checkCreationRoute("phone", "cross-platform", false)).toThrow(
      expect.objectContaining({ name: "LocalPasskeyRequiredError" }),
    )
  })

  it("holds a chained answer to the class the creation admitted, in both directions", () => {
    // A key creation whose chained assertion comes back local, and its inverse. The key case is
    // sent back to the key, never to a QR code that a phone creation would refuse anyway.
    expect(() => checkCreationRoute("phone", "platform", true)).toThrow(
      expect.objectContaining({ name: "SecurityKeyRequiredError" }),
    )
    expect(() => checkCreationRoute("phone", "cross-platform", false)).toThrow(
      expect.objectContaining({ name: "LocalPasskeyRequiredError" }),
    )
  })

  it("refuses an unreported attachment on either posture, even for a key", () => {
    for (const posture of ["phone", "laptop"] as const) {
      for (const securityKey of [true, false]) {
        expect(() => checkCreationRoute(posture, undefined, securityKey)).toThrow(
          expect.objectContaining({ name: expect.stringMatching(/RequiredError$/) }),
        )
      }
    }
  })
})

describe("the assertion route rule", () => {
  it("a laptop still needs another device", () => {
    expect(() => checkAssertionRoute("laptop", "cross-platform")).not.toThrow()
    for (const attachment of ["platform", undefined] as const) {
      expect(() => checkAssertionRoute("laptop", attachment)).toThrow(
        expect.objectContaining({ name: "PhoneRequiredError" }),
      )
    }
  })

  it("a phone takes any answer, including one whose attachment went unreported", () => {
    for (const attachment of ["platform", "cross-platform", undefined] as const) {
      expect(() => checkAssertionRoute("phone", attachment)).not.toThrow()
    }
  })

  it("with the local route allowed, a laptop admits its own passkey but still fails closed on an unnamed route", () => {
    expect(() => checkAssertionRoute("laptop", "platform", true)).not.toThrow()
    expect(() => checkAssertionRoute("laptop", "cross-platform", true)).not.toThrow()
    // An unreported attachment is refused even with the opt-in: nothing may pick a slot from it.
    expect(() => checkAssertionRoute("laptop", undefined, true)).toThrow(
      expect.objectContaining({ name: "PhoneRequiredError" }),
    )
  })
})

describe("hints", () => {
  it("an assertion sends a laptop only what its consumer asked for, and a phone none", () => {
    expect(hintsFor("laptop")).toBeUndefined()
    expect(hintsFor("laptop", undefined)).toBeUndefined()
    expect(hintsFor("laptop", null)).toBeUndefined()
    expect(hintsFor("laptop", ["security-key"])).toEqual(["security-key"])
    expect(hintsFor("laptop", ["hybrid"])).toEqual(["hybrid", "security-key"])
    // A phone sign-in legitimately accepts another phone over QR, so it is never steered.
    expect(hintsFor("phone")).toBeUndefined()
    expect(hintsFor("phone", ["hybrid"])).toBeUndefined()
  })

  it("a creation names a phone's two admitted classes, and leaves a laptop as it was", () => {
    expect(creationHintsFor("phone")).toEqual(["client-device", "security-key"])
    // Never hybrid: the route rule would refuse what it would open.
    expect(creationHintsFor("phone")).not.toContain("hybrid")
    expect(creationHintsFor("phone", ["hybrid"])).toEqual(["client-device", "security-key"])
    expect(creationHintsFor("laptop")).toBeUndefined()
    expect(creationHintsFor("laptop", null)).toBeUndefined()
    expect(creationHintsFor("laptop", ["hybrid"])).toEqual(["hybrid", "security-key"])
  })

  it("a laptop always names a security key, after the route it was asked for", () => {
    // A password manager's extension takes the request over unless a security key is named.
    expect(hintsFor("laptop", ["hybrid"])).toEqual(["hybrid", "security-key"])
    expect(hintsFor("laptop", ["security-key", "hybrid"])).toEqual(["security-key", "hybrid"])
    expect(creationHintsFor("laptop", ["hybrid"])).toEqual(["hybrid", "security-key"])
    expect(signInHintsFor("laptop", ["hybrid"])).toEqual(["hybrid", "security-key"])
    expect(signInHintsFor("laptop", ["security-key"])).toEqual(["security-key"])
    // Phones are never steered, so nothing is added there either.
    expect(hintsFor("phone", ["hybrid"])).toBeUndefined()
  })

  it("a laptop sign-in names both routes it accepts, since a local answer is refused anyway", () => {
    expect(signInHintsFor("laptop")).toEqual(["hybrid", "security-key"])
    expect(signInHintsFor("laptop", undefined)).toEqual(["hybrid", "security-key"])
    // Both, never hybrid alone: a sheet that honours hybrid may drop the security-key row.
    expect(signInHintsFor("laptop")).toContain("security-key")
  })

  it("a laptop sign-in still takes a consumer's own hints, and its suppression", () => {
    expect(signInHintsFor("laptop", ["security-key"])).toEqual(["security-key"])
    expect(signInHintsFor("laptop", null)).toBeUndefined()
  })

  it("a laptop sign-in that admits its own copy opens on this computer, naming a security key only for one", () => {
    // No security key named: a manager's extension may answer for a synced passkey.
    expect(signInHintsFor("laptop", undefined, true)).toEqual(["client-device"])
    expect(signInHintsFor("laptop", undefined, true, false)).toEqual(["client-device"])
    // A credential known to be a hardware key names one, so the extension stands aside.
    expect(signInHintsFor("laptop", undefined, true, true)).toEqual([
      "client-device",
      "security-key",
    ])
    // A consumer's own hints still win, even with the local route open.
    expect(signInHintsFor("laptop", ["hybrid"], true)).toEqual(["hybrid", "security-key"])
    expect(signInHintsFor("laptop", ["hybrid"], true, true)).toEqual(["hybrid", "security-key"])
    // Suppression still wins too.
    expect(signInHintsFor("laptop", null, true)).toBeUndefined()
    expect(signInHintsFor("laptop", null, true, true)).toBeUndefined()
  })

  it("a phone sign-in sends none: another phone over QR is an answer it accepts", () => {
    expect(signInHintsFor("phone")).toBeUndefined()
    expect(signInHintsFor("phone", ["hybrid"])).toBeUndefined()
    expect(signInHintsFor("phone", null)).toBeUndefined()
  })
})
