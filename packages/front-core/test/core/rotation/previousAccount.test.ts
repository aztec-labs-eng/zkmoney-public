import type { RecoveryMetadata } from "@obsidion/sdk"
import { describe, expect, it } from "vitest"
import { isDust, previousRootKey } from "../../../src/core/rotation/previousAccount"

const A = "a1".repeat(64)
const B = "b2".repeat(64)
const C = "c3".repeat(64)
const OWNER = "0x00000000000000000000000000000000000000Ee"
const TWO_KEY = `0x${"22".repeat(32)}`
const ENVELOPE = `0x${"01".repeat(62)}`

const root = (over: Partial<RecoveryMetadata> = {}): RecoveryMetadata => ({
  credentialId: "root-credential",
  l2Address: TWO_KEY,
  pubkey: A,
  isMskRoot: true,
  passkeySet: [A, B],
  ...over,
})

const backup = (over: Partial<RecoveryMetadata> = {}): RecoveryMetadata => ({
  credentialId: "backup-credential",
  l2Address: TWO_KEY,
  pubkey: B,
  isMskRoot: false,
  backup: { account: OWNER, envelope: ENVELOPE },
  passkeySet: [A, B],
  ...over,
})

describe("previousRootKey", () => {
  it("names the root key from the root's record and from the backup's", () => {
    expect(previousRootKey(root())).toBe(A)
    expect(previousRootKey(backup())).toBe(A)
  })

  it("names the root from records as the wallet writes them", () => {
    // The re-root's pair: the root's stored fields carried over, the backup's from the rotation.
    const rerootRoot = root({ prfSlot: "first", authenticatorType: "platform" })
    const rerootBackup = {
      ...backup({ prfSlot: "second", authenticatorType: "security-key", transports: ["usb"] }),
      userHandle: "YWxpY2U",
    }
    // A sign-in by tag takes the set in the chain's order, which may list the backup first.
    const byTagRoot = root({ prfSlot: "first", passkeySet: [B, A], authenticatorType: "platform" })
    const byTagBackup = backup({
      prfSlot: "second",
      passkeySet: [B, A],
      authenticatorType: "platform",
    })
    // A browser only ever opened with the backup holds the backup's record alone.
    const backupOnly = backup({ prfSlot: "first", authenticatorType: "platform" })
    // A Ledger's raw credential id may begin with the byte oxide's envelope prefix uses.
    const raw = new Uint8Array(95).map((_, i) => (i * 37 + 11) & 0xff)
    raw[0] = 0x01
    const ledgerRoot = root({
      credentialId: Buffer.from(raw).toString("base64url"),
      authenticatorType: "security-key",
    })
    for (const record of [rerootRoot, rerootBackup, byTagRoot, byTagBackup, backupOnly, ledgerRoot])
      expect(previousRootKey(record)).toBe(A)
  })

  it("names nothing without a two-key set holding the record's own key", () => {
    const { passkeySet: _, ...unrotated } = root()
    expect(previousRootKey(unrotated)).toBeUndefined()
    expect(previousRootKey(root({ passkeySet: [A] }))).toBeUndefined()
    expect(previousRootKey(root({ passkeySet: [A, B, C] }))).toBeUndefined()
    expect(previousRootKey(backup({ passkeySet: [A, B, C] }))).toBeUndefined()
    expect(previousRootKey(root({ passkeySet: [A, A] }))).toBeUndefined()
    expect(previousRootKey(root({ passkeySet: [A, `0x${A.toUpperCase()}`] }))).toBeUndefined()
    expect(previousRootKey(root({ pubkey: C }))).toBeUndefined()
    expect(previousRootKey(backup({ pubkey: C }))).toBeUndefined()
  })

  it("names nothing over a key that is not 64 bytes of hex", () => {
    expect(previousRootKey(root({ pubkey: "0x1234" }))).toBeUndefined()
    expect(previousRootKey(backup({ passkeySet: ["zz".repeat(64), B] }))).toBeUndefined()
  })

  it("compares keys across a 0x prefix and case, and names the root unprefixed in lowercase", () => {
    expect(previousRootKey(root({ pubkey: `0x${A.toUpperCase()}` }))).toBe(A)
    expect(previousRootKey(root({ passkeySet: [`0X${A}`, B.toUpperCase()] }))).toBe(A)
    expect(previousRootKey(backup({ pubkey: `0x${B}`, passkeySet: [A.toUpperCase(), B] }))).toBe(A)
  })
})

describe("isDust", () => {
  it("counts an amount below the floor as dust and one at the floor as not", () => {
    expect(isDust(9n, 10n)).toBe(true)
    expect(isDust(10n, 10n)).toBe(false)
    expect(isDust(0n, 0n)).toBe(false)
  })
})
