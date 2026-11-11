import type { Database } from "@obsidion/front-core"
import { updatePasskeyNames } from "../platform/storage/deviceKeys"

export const MAX_PASSKEY_NAME = 24

/**
 * Saves a trimmed name for the key in the device's `passkeyNames`; an empty one drops it. Nothing
 * leaves the browser.
 */
export function savePasskeyName(db: Database, pubkeyHex: string, name: string): void {
  const trimmed = name.trim().replace(/\s+/g, " ").slice(0, MAX_PASSKEY_NAME)
  updatePasskeyNames(db, (saved) => {
    const next: Record<string, string> = { ...saved }
    delete next[pubkeyHex]
    if (trimmed) next[pubkeyHex] = trimmed
    return next
  })
}
