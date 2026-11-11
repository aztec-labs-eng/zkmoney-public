import type { Database } from "@obsidion/front-core"
import {
  LaptopPasskeyRefusedError,
  UnsupportedProviderError,
  extensionAnswersPasskeys,
} from "@obsidion/passkey-web"
import { updateLocalRefusals } from "../storage/deviceKeys"

/**
 * How often this browser's sign-ups on this computer were refused because a manager the row does
 * not admit answered, while an extension answers the page's passkeys, is the device's
 * `localRefusals`. The sign-up sheet reads it to stop leading with a route that keeps leaving a
 * refused passkey behind.
 */

/** Above this many refusals the sheet changes. */
export const LOCAL_REFUSAL_LIMIT = 2

/** A refusal another manager's answer causes. Apple Passwords refused here has its own card. */
export function countsAsLocalRefusal(err: unknown): boolean {
  if (err instanceof UnsupportedProviderError) return err.kind === "manager"
  return err instanceof LaptopPasskeyRefusedError && !err.appleRefusedHere
}

/** Whether the sheet stops leading with this computer: past the limit, and an extension still answers. */
export const localRefusalsOverLimit = (extension: boolean, refusals: number): boolean =>
  extension && refusals > LOCAL_REFUSAL_LIMIT

/**
 * Keeps the count for a creation on this computer, where the creation driver settles: an accepted
 * passkey clears it whatever the sign-up does next, and a refusal another manager caused adds one.
 * A count that cannot be saved is lost, never the creation's result.
 */
export async function countingLocalRefusals<T>(db: Database, creation: Promise<T>): Promise<T> {
  try {
    const made = await creation
    updateLocalRefusals(db, () => 0)
    return made
  } catch (err) {
    if (extensionAnswersPasskeys("create") && countsAsLocalRefusal(err))
      updateLocalRefusals(db, (refusals) => refusals + 1)
    throw err
  }
}
