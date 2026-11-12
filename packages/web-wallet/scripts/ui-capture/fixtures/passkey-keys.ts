import * as actual from "@obsidion/front-core"
import type { Hex } from "viem"
import {
  BACKUP_OWNER,
  backupFixture,
  keyPubkey,
  sessionPubkeyHex,
  type FixtureKey,
} from "./backup-passkey"
export * from "@obsidion/front-core"

/*
 * The Passkeys sheet's key read, answered from the open backup fixture: the account it resolves
 * and the keys installed on it.
 */

/** A raw credential id for the sign-up key; oxide's envelope prefix for a backup. */
const metadataOf = (key: FixtureKey): Hex =>
  key.role === "sign-up" ? `0x${"c1".repeat(32)}` : `0x01${"ab".repeat(32)}0101${"00".repeat(60)}`

export const resolveOxideIdentity: typeof actual.resolveOxideIdentity = async (...args) => {
  const fixture = backupFixture()
  if (!fixture) return actual.resolveOxideIdentity(...args)
  if (fixture.keys === "unverified") return { kind: "none" }
  return {
    kind: "verified",
    identity: { account: BACKUP_OWNER, nameHash: `0x${"0".repeat(64)}`, generations: [] },
  }
}

export const createOxideL1Reader: typeof actual.createOxideL1Reader = (client) => {
  const reader = actual.createOxideL1Reader(client)
  const fixture = backupFixture()
  if (!fixture) return reader
  return {
    ...reader,
    readAuthKeysCounted: async () => {
      if (fixture.keys === "loading") return new Promise<never>(() => {})
      if (typeof fixture.keys !== "object")
        throw new actual.WalletError("unknown", "capture key read failed")
      const session = await sessionPubkeyHex()
      const entries = fixture.keys.map((key) => {
        const pubkey = keyPubkey(key, session)
        return {
          key: { qx: `0x${pubkey.slice(0, 64)}` as Hex, qy: `0x${pubkey.slice(64)}` as Hex },
          metadata: metadataOf(key),
        }
      })
      return { entries, authKeyCount: entries.length }
    },
  }
}
