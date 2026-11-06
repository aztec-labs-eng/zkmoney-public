import { stageIdentity, type Database, type ReadonlyStore } from "@obsidion/front-core"
import type { WebAlphaAuthService } from "../../platform/auth/WebAlphaAuthService"
import {
  NO_SESSION,
  clearSessionEverywhere,
  type SessionLock,
} from "../../platform/storage/activeStorage"
import { stageDeviceKeys, type DeviceState } from "../../platform/storage/deviceKeys"
import { activeNamespace } from "../../session/session"

/** The page's auth service, database, device keys and session lock: the session a sign-out ends. */
export interface SignOutPage {
  auth: Pick<WebAlphaAuthService, "lockOut">
  database: Database
  device: ReadonlyStore<DeviceState>
  sessionLock: SessionLock
}

export type SignOutOptions = {
  keepPointers?: boolean
  /** Leave other rollups' sessions alone: for a sign-out the user did not ask for. */
  localOnly?: boolean
}

/**
 * The destructive half of signing out, with no navigation. The in-memory key and the retired
 * session go at once, with a fence that keeps any cache from restoring the key until the next
 * commit. Then, under the session lock a sign-in's commit also takes, the session tuple leaves every
 * other rollup's database and any copy an older build left in `localStorage`, and the committed
 * account's identity, this rollup's cached key and its pointers go as one transaction. It resolves
 * once everything is saved, so callers that navigate await it. The passkey and the on-chain claim
 * survive. The onboarding wizard keeps the pointers, because its pending registration record lives
 * under them.
 */
export async function signOut(page: SignOutPage, options: SignOutOptions = {}): Promise<void> {
  page.auth.lockOut()
  await page.sessionLock(async () => {
    if (!options.localOnly) await clearSessionEverywhere()
    await page.database.write(async (w) => {
      stageIdentity(w, activeNamespace(page.device).prefix, null)
      stageDeviceKeys(w, options.keepPointers ? { msk: null } : NO_SESSION)
    })
  })
}
