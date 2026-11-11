/**
 * What one tab keeps across its own reloads: a claim link and its ticket marker, a connect packet,
 * the signup before its passkey, a past user's check, link reads, once-per-tab marks, the boot's
 * reload count and the dev keys.
 */
export type TabKey =
  | "obsidion.pending-claim"
  | "obsidion.pending-claim.ticket"
  | "obsidion.pending-connect"
  | `obsidion.name-grant${string}`
  | "obsidion.drawn-offer"
  | `obsidion.tag-${string}`
  | "zkm.pastUserVerified"
  | `zkm.pastUserCheck.${string}`
  | `obsidion.link-read:${string}`
  | `zkm.once.${string}`
  | "pxeBoot.downloadReloads"
  | "webwallet.demo"
  | "webwallet.preview-config-draft"

/** Values one tab keeps across its own navigations and reloads, gone once the tab closes. */
export const tabStash = {
  get: (key: TabKey): string | null => sessionStorage.getItem(key),
  set: (key: TabKey, value: string): void => sessionStorage.setItem(key, value),
  remove: (key: TabKey): void => sessionStorage.removeItem(key),
}
