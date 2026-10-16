import {
  LaptopPasskeyRefusedError,
  UnsupportedProviderError,
  extensionAnswersPasskeys,
} from "@obsidion/passkey-web"
import { deviceStorage } from "../storage/rollupStorage"

/**
 * How often this browser's sign-ups on this computer were refused because a manager the row does
 * not admit answered, while an extension answers the page's passkeys. The sign-up sheet reads it to
 * stop leading with a route that keeps leaving a refused passkey behind.
 */

const STORAGE_KEY = "webwallet.local-refusals"

/** Above this many refusals the sheet changes. */
export const LOCAL_REFUSAL_LIMIT = 2

/** A refusal another manager's answer causes. Apple Passwords below the macOS floor has its own card. */
export function countsAsLocalRefusal(err: unknown): boolean {
  if (err instanceof UnsupportedProviderError) return err.kind === "manager"
  return err instanceof LaptopPasskeyRefusedError && !err.belowMacFloor
}

export function localRefusalCount(): number {
  try {
    const count = Number(deviceStorage.getItem(STORAGE_KEY))
    return Number.isInteger(count) && count > 0 ? count : 0
  } catch {
    return 0
  }
}

export function noteLocalRefusal(): void {
  try {
    deviceStorage.setItem(STORAGE_KEY, String(localRefusalCount() + 1))
  } catch {
    // A browser that keeps nothing counts nothing.
  }
}

export function clearLocalRefusals(): void {
  try {
    deviceStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing was kept.
  }
}

/** Whether the sheet stops leading with this computer: past the limit, and an extension still answers. */
export const localRefusalsOverLimit = (extension: boolean): boolean =>
  extension && localRefusalCount() > LOCAL_REFUSAL_LIMIT

/**
 * Keeps the count for a creation on this computer, where the creation driver settles: an accepted
 * passkey clears it whatever the sign-up does next, and a refusal another manager caused adds one.
 */
export async function countingLocalRefusals<T>(creation: Promise<T>): Promise<T> {
  try {
    const made = await creation
    clearLocalRefusals()
    return made
  } catch (err) {
    if (extensionAnswersPasskeys("create") && countsAsLocalRefusal(err)) noteLocalRefusal()
    throw err
  }
}
