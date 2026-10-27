import { deviceStorage } from "../platform/storage/rollupStorage"

const KEY = "webwallet.passkey-names"
export const MAX_PASSKEY_NAME = 24

export type PasskeyNames = Readonly<Record<string, string>>

/** The names this browser gave the account's passkeys, by public key. Nothing leaves the browser. */
export function readPasskeyNames(): PasskeyNames {
  try {
    const parsed: unknown = JSON.parse(deviceStorage.getItem(KEY) ?? "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === "string" && v.length > 0),
    ) as PasskeyNames
  } catch {
    return {}
  }
}

/** Saves a trimmed name under the key; an empty one drops it. Returns the names as saved. */
export function savePasskeyName(pubkeyHex: string, name: string): PasskeyNames {
  const trimmed = name.trim().replace(/\s+/g, " ").slice(0, MAX_PASSKEY_NAME)
  const { [pubkeyHex]: _, ...rest } = readPasskeyNames()
  const names: PasskeyNames = trimmed ? { ...rest, [pubkeyHex]: trimmed } : rest
  try {
    deviceStorage.setItem(KEY, JSON.stringify(names))
  } catch {
    // The name shows for this open modal either way.
  }
  return names
}
