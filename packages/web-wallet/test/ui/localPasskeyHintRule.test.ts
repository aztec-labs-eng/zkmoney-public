// @vitest-environment node
/** Who is told that this computer's copy of the passkey may answer, and for how many showings. */
import { APPLE_ICLOUD_AAGUID, GPM_AAGUID } from "@obsidion/core/constants"
import { describe, expect, it, vi } from "vitest"
import { localPasskeyHintApplies } from "../../src/ui/LocalPasskeyHint"

type Readers = NonNullable<Parameters<typeof localPasskeyHintApplies>[0]>
const readers = (over: Partial<Readers> = {}): Readers => ({
  posture: () => "laptop",
  shown: () => 0,
  record: () => ({ answered: "remote" }),
  osFamily: () => "macos",
  ...over,
})

describe("localPasskeyHintApplies", () => {
  it("a laptop whose passkey answered from another device is told, until the third showing", () => {
    expect(localPasskeyHintApplies(readers())).toBe(true)
    expect(localPasskeyHintApplies(readers({ shown: () => 2 }))).toBe(true)
    expect(localPasskeyHintApplies(readers({ shown: () => 3 }))).toBe(false)
  })

  it("a phone, a local answer, no answer and no record are not", () => {
    expect(localPasskeyHintApplies(readers({ posture: () => "phone" }))).toBe(false)
    expect(localPasskeyHintApplies(readers({ record: () => ({ answered: "local" }) }))).toBe(false)
    expect(localPasskeyHintApplies(readers({ record: () => ({}) }))).toBe(false)
    expect(localPasskeyHintApplies(readers({ record: () => undefined }))).toBe(false)
  })

  it("a record known to be a hardware key is not, whatever it answered", () => {
    const key = (over: object) => () => ({ answered: "remote" as const, ...over })
    expect(localPasskeyHintApplies(readers({ record: key({ transports: ["usb"] }) }))).toBe(false)
    expect(
      localPasskeyHintApplies(readers({ record: key({ inferredTransports: ["usb", "nfc"] }) })),
    ).toBe(false)
    expect(
      localPasskeyHintApplies(readers({ record: key({ transports: ["hybrid", "internal"] }) })),
    ).toBe(true)
  })

  it("an iCloud Keychain passkey is told on a Mac only; other providers anywhere", () => {
    const icloud = () => ({ answered: "remote" as const, prfAaguid: APPLE_ICLOUD_AAGUID })
    expect(localPasskeyHintApplies(readers({ record: icloud }))).toBe(true)
    for (const os of ["windows", "linux", "chromeos"] as const) {
      expect(localPasskeyHintApplies(readers({ record: icloud, osFamily: () => os }))).toBe(false)
    }
    const gpm = () => ({ answered: "remote" as const, prfAaguid: GPM_AAGUID })
    expect(localPasskeyHintApplies(readers({ record: gpm, osFamily: () => "windows" }))).toBe(true)
  })

  it("reads no record for a phone or once the showings are spent", () => {
    const record = vi.fn(() => ({ answered: "remote" as const }))
    localPasskeyHintApplies(readers({ posture: () => "phone", record }))
    localPasskeyHintApplies(readers({ shown: () => 3, record }))
    expect(record).not.toHaveBeenCalled()
  })
})
