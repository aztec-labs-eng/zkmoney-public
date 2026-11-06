/** What the account's payment requests read beside its own namespace. */
import { walletStorage } from "./walletStorage"

/** Ids of the Receive codes minted without an amount, kept apart from the requests. Read only. */
const LEGACY_UNLISTED_KEY = "webwallet.receiveCode.unlisted"

export function legacyUnlisted(): string[] {
  try {
    const parsed: unknown = JSON.parse(walletStorage.getItem(LEGACY_UNLISTED_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.map((id) => String(id).toLowerCase()) : []
  } catch {
    return []
  }
}
