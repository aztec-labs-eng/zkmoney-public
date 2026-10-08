/**
 * The hand-off material holder: taken once, only by the hand-off naming its credential under this
 * relying party, and only while its stamp is live.
 */
import { beforeEach, describe, expect, it } from "vitest"
import {
  HANDOFF_FUTURE_SKEW_MS,
  HANDOFF_MAX_AGE_MS,
  __resetHandoffMaterialForTests,
  holdHandoffMaterial,
  takeHandoffMaterial,
  type HandoffMaterial,
} from "../src/platform/storage/handoffMaterial"

const NOW = 1_757_000_000_000
const material = (overrides: Partial<HandoffMaterial> = {}): HandoffMaterial => ({
  v: 1,
  derivedAt: NOW,
  rpId: "localhost",
  credentialId: "cred",
  pubkeyHex: `0x${"ab".repeat(64)}`,
  candidates: { first: `0x${"11".repeat(32)}` },
  ...overrides,
})

beforeEach(() => __resetHandoffMaterialForTests())

describe("hand-off material", () => {
  it("is taken once, by the hand-off naming its credential", () => {
    holdHandoffMaterial(material())
    expect(takeHandoffMaterial("cred", "localhost", NOW)).toEqual(material())
    expect(takeHandoffMaterial("cred", "localhost", NOW)).toBeNull()
  })

  it("stays for its own hand-off when another credential asks", () => {
    holdHandoffMaterial(material())
    expect(takeHandoffMaterial("other", "localhost", NOW)).toBeNull()
    expect(takeHandoffMaterial("cred", "localhost", NOW)).not.toBeNull()
  })

  it("is dropped under another relying party", () => {
    holdHandoffMaterial(material())
    expect(takeHandoffMaterial("cred", "auth.zk.money", NOW)).toBeNull()
    expect(takeHandoffMaterial("cred", "localhost", NOW)).toBeNull()
  })

  it("is accepted just inside its window and dropped outside it", () => {
    for (const [derivedAt, live] of [
      [NOW - HANDOFF_MAX_AGE_MS, true],
      [NOW + HANDOFF_FUTURE_SKEW_MS, true],
      [NOW - HANDOFF_MAX_AGE_MS - 1, false],
      [NOW + HANDOFF_FUTURE_SKEW_MS + 1, false],
      [NOW + 0.5, false],
    ] as const) {
      holdHandoffMaterial(material({ derivedAt }))
      expect(takeHandoffMaterial("cred", "localhost", NOW) !== null, String(derivedAt)).toBe(live)
      expect(takeHandoffMaterial("cred", "localhost", NOW)).toBeNull()
    }
  })
})
