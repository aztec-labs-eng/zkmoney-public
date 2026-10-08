import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { withWebLock } from "../../platform/storage/webLock"

/** One key per account: `:<l2 address>` follows. */
const ENTERED_KEY_PREFIX = "onboarding.walletEntered"

/**
 * Marks that this browser entered the wallet on the account from signup, and says whether that is
 * the first time. The mark is kept with the account's data, like the pending registration, so
 * resuming a registration after logging out of it is a return, not a new entry. It never leaves
 * the device. Exits can overlap (two effects in one render), so the check and the mark share a
 * lock and only one of them is first.
 */
export async function firstWalletEntry(address: string): Promise<boolean> {
  const key = `${ENTERED_KEY_PREFIX}:${address.toLowerCase()}`
  try {
    return await withWebLock(key, async () => {
      if ((await webStorage.getItem(key)) !== null) return false
      await webStorage.setItem(key, "1")
      return true
    })
  } catch {
    // Without the mark or its lock, a return cannot be told from a first entry.
    return false
  }
}
