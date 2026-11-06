import type { Database, ReadonlyStore, Write } from "@obsidion/front-core"
import { NO_SESSION, cachedMsk, clearCachedMsk } from "../storage/activeStorage"
import { stageDeviceKeys, type DeviceState } from "../storage/deviceKeys"
import { WebPasskeyIdentityMap } from "./WebPasskeyIdentityMap"

/**
 * Writes the session, so only the active tab runs it: once it has opened its databases, before
 * account consumers mount, including when there is no cached key.
 */
export async function discardIncompatiblePasskeyState(
  db: Database,
  device: ReadonlyStore<DeviceState>,
  rpId: string,
  clearIdentity: (w: Write) => void,
): Promise<void> {
  const identities = new WebPasskeyIdentityMap(db, rpId)
  const { credentialId } = device.get()
  const record = credentialId ? await identities.get(credentialId) : undefined
  if (!record || !device.get().storageId) {
    await db.write(async (w) => {
      stageDeviceKeys(w, NO_SESSION)
      clearIdentity(w)
    })
  } else {
    const cache = cachedMsk(device.get())
    if (
      cache &&
      (cache.credentialId !== credentialId || cache.storageId !== device.get().storageId)
    ) {
      await clearCachedMsk(db)
    }
  }
  await identities.discardOtherRps()
}
