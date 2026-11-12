// @vitest-environment node
/** Which one-passkey accounts Home and Settings nudge to add a backup passkey, and with which card. */
import { GPM_AAGUID } from "@obsidion/core/constants"
import { PROTON_PASS_AAGUID } from "@obsidion/passkey-web"
import { describe, expect, it } from "vitest"
import {
  backupNudge,
  balanceThreshold,
  homeNudge,
  type HomeNudgeFacts,
} from "../../../src/features/backupPasskey/backupReminder"
import type { BackupRecord } from "../../../src/platform/auth/WebPasskeyIdentityMap"

const DOLLAR = 10n ** 18n

const nudge = (record: BackupRecord | undefined) =>
  backupNudge({ enabled: true, record, noAddSaved: true, backupOnChain: false })

const home = (over: Partial<HomeNudgeFacts>) =>
  homeNudge({
    enabled: true,
    record: { backupEligible: true },
    noAddSaved: true,
    backupOnChain: false,
    balance: 0n,
    busy: false,
    putOffAt: null,
    hiddenForSession: false,
    awaitsApproval: false,
    moveUnfinished: false,
    ...over,
  })

describe("backupNudge", () => {
  it("reads the authenticator's backup flag where the record keeps it", () => {
    expect(nudge({ backupEligible: false })).toBe("oneDevice")
    expect(nudge({ backupEligible: true, securityKey: true })).toBe("oneKey")
  })

  it("classifies a synced passkey by its flag, whatever provider id its creation recorded", () => {
    const proton = { backupEligible: true, prfAaguid: PROTON_PASS_AAGUID }
    expect(nudge(proton)).toBe("oneKey")
    expect(nudge({ backupEligible: true, prfAaguid: GPM_AAGUID })).toBe("oneKey")
    // An adopted or older record carries no id.
    expect(nudge({ backupEligible: true })).toBe("oneKey")
    expect(nudge({ ...proton, backup: { account: "0xowner", envelope: "0x01" } })).toBeUndefined()
    expect(nudge({ ...proton, passkeySet: ["ab", "cd"] })).toBeUndefined()
  })

  it("counts a record without the flag as one device only when it is a security key", () => {
    expect(nudge({ securityKey: true })).toBe("oneDevice")
    expect(nudge({})).toBe("oneKey")
  })

  it("never nudges a two-key account or one with a backup", () => {
    expect(nudge({ backupEligible: false, passkeySet: ["ab"] })).toBe("oneDevice")
    expect(nudge({ backupEligible: false, passkeySet: ["ab", "cd"] })).toBeUndefined()
    const backup = { account: "0xowner", envelope: "0x01" }
    expect(nudge({ backupEligible: false, backup })).toBeUndefined()
    expect(nudge({ backupEligible: true, backup })).toBeUndefined()
  })

  it("nudges no one while the build lacks the add, or once a backup or add exists", () => {
    const facts = {
      enabled: true,
      record: { backupEligible: true },
      noAddSaved: true,
      backupOnChain: false,
    }
    expect(backupNudge(facts)).toBe("oneKey")
    for (const over of [
      { enabled: false },
      { backupOnChain: true },
      { noAddSaved: false },
      { record: undefined },
    ]) {
      expect(backupNudge({ ...facts, ...over })).toBeUndefined()
    }
  })
})

describe("balanceThreshold", () => {
  it("steps tenfold from $100", () => {
    expect(balanceThreshold(100n * DOLLAR - 1n)).toBeUndefined()
    expect(balanceThreshold(100n * DOLLAR)).toBe(100n * DOLLAR)
    expect(balanceThreshold(1_000n * DOLLAR - 1n)).toBe(100n * DOLLAR)
    expect(balanceThreshold(25_000n * DOLLAR)).toBe(10_000n * DOLLAR)
  })
})

describe("homeNudge", () => {
  it("asks for a waiting add's last approval before anything else, only in a build with the add", () => {
    expect(home({ awaitsApproval: true, noAddSaved: false })).toEqual({ kind: "finish" })
    expect(home({ awaitsApproval: true, enabled: false })).toBeUndefined()
  })

  it("asks to go on with a move from the earlier address, after a waiting add and before the rest, in every build", () => {
    const oneDevice = { record: { backupEligible: false }, balance: 1n }
    expect(home({ moveUnfinished: true, ...oneDevice })).toEqual({ kind: "moveFunds" })
    expect(home({ moveUnfinished: true, awaitsApproval: true })).toEqual({ kind: "finish" })
    // Account history moves funds in a build without the add too.
    expect(home({ moveUnfinished: true, enabled: false })).toEqual({ kind: "moveFunds" })
  })

  it("shows a passkey on one device once Main holds funds, until put off for the session", () => {
    const oneDevice = { record: { backupEligible: false } }
    expect(home({ ...oneDevice, balance: 0n })).toBeUndefined()
    expect(home({ ...oneDevice, balance: undefined })).toBeUndefined()
    expect(home({ ...oneDevice, balance: 1n, putOffAt: "unread" })).toEqual({ kind: "oneDevice" })
    expect(home({ ...oneDevice, balance: 1n, hiddenForSession: true })).toBeUndefined()
  })

  it("shows any other one-passkey account at a threshold, and after a Not now only at a higher one", () => {
    expect(home({ balance: 99n * DOLLAR })).toBeUndefined()
    expect(home({ balance: 150n * DOLLAR })).toEqual({ kind: "oneKey", threshold: 100n * DOLLAR })
    expect(home({ balance: 150n * DOLLAR, hiddenForSession: true })).toEqual({
      kind: "oneKey",
      threshold: 100n * DOLLAR,
    })
    const putOff = { putOffAt: 100n * DOLLAR }
    expect(home({ ...putOff, balance: 999n * DOLLAR })).toBeUndefined()
    expect(home({ ...putOff, balance: 1_000n * DOLLAR })).toEqual({
      kind: "oneKey",
      threshold: 1_000n * DOLLAR,
    })
  })

  it("waits while a withdrawal or Savings move runs, and while the saved Not now does not read", () => {
    const at = { balance: 150n * DOLLAR }
    expect(home({ ...at, busy: true })).toBeUndefined()
    expect(home({ ...at, putOffAt: "unread" })).toBeUndefined()
  })
})
