import { readIdentity, stageIdentity, type WalletIdentity } from "@obsidion/front-core"
import { activeNamespace, namespaceOf, openedSession } from "../../src/session/session"
import { seedDeviceKeys, testCore } from "./page"

const ADDRESS = `0x${"1d".repeat(32)}`

/**
 * The committed namespace's entered account as onboarding saves it, or none. Resolves once the open
 * session's identity reads it.
 */
export async function setIdentity(identity?: Partial<WalletIdentity> | null) {
  const { database, device } = testCore()
  const saved = identity ? { address: ADDRESS, claimedAt: 1, ...identity } : null
  await database.write(async (w) => stageIdentity(w, activeNamespace(device).prefix, saved))
  await openedSession.get()?.identity.ready
}

/** The entered account and the passkey record that opened it under `rpId`. */
export async function seedOnboarded(identity: Partial<WalletIdentity>, rpId: string) {
  await setIdentity(identity)
  const entry = { rpId, l2Address: identity.address ?? ADDRESS, isMskRoot: true, createdAt: 1 }
  await seedDeviceKeys({
    passkeyMap: JSON.stringify({ version: 1, entries: { cred: entry } }),
  })
}

/** The identity saved in `storageId`'s namespace, the committed one's by default. */
export function savedIdentity(storageId = testCore().device.get().storageId) {
  return readIdentity(testCore().database.scoped(namespaceOf(storageId).prefix))
}
