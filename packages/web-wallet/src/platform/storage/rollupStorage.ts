/**
 * The `localStorage` side of the wallet: device keys, this browser's rather than a rollup's. They
 * no-op without `localStorage`.
 */
/** The demo boot's rollup: no profile can carry it, so its database is no real rollup's. */
export const DEMO_ROLLUP = "demo"

/**
 * The keys this build keeps in `localStorage`, each read before any wallet database opens: a user's
 * node choice, which outlives a roll; the analytics base id; the signup's channel and source, kept
 * an hour; an invite link's code, until the signup it brought names its inviter; and the color
 * theme, which index.html applies before the boot screen paints.
 */
export const DEVICE_STORAGE_KEYS = [
  "webwallet.endpoints",
  "zkm_bid",
  "webwallet.attribution",
  "webwallet.inbound-invite",
  "webwallet.theme",
] as const
export type DeviceStorageKey = (typeof DEVICE_STORAGE_KEYS)[number]

const storage = () => (typeof localStorage === "undefined" ? undefined : localStorage)

/** Unprefixed access to {@link DEVICE_STORAGE_KEYS}. */
export const deviceStorage = {
  getItem: (key: DeviceStorageKey): string | null => storage()?.getItem(key) ?? null,
  setItem: (key: DeviceStorageKey, value: string): void => storage()?.setItem(key, value),
  removeItem: (key: DeviceStorageKey): void => storage()?.removeItem(key),
}
