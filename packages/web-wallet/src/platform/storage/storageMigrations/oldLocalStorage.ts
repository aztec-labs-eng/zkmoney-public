/**
 * Storage migration: the wallet state older builds kept in `localStorage`. Remove when no supported
 * build writes wallet keys to `localStorage` outside `DEVICE_STORAGE_KEYS`.
 */
import { DEVICE_KEYS, PREF_KEYS } from "../deviceKeys"
import { DEVICE_STORAGE_KEYS } from "../rollupStorage"

/** Older builds' `rollup.<version>.` partitions. */
const PREFIX = "rollup."
/** Families older builds kept wallet state under, at the top level and in partitions. */
const OLD_WALLET_FAMILIES = ["webwallet.", "obsidion.", "obsidion-google-callback"]
/**
 * An older build's Google sign-in relay, in the active partition: a sign-in may still be live. A
 * result holds an `id_token`; its own reaper removed it, with its beacon, once past its timeout.
 */
const RELAY_FAMILY = "obsidion-google-callback"
const RELAY_TIMEOUT_MS = 5 * 60_000
/** This build's keys, and the older builds' keys that device state's load still carries. */
const KEPT: ReadonlySet<string> = new Set([
  ...DEVICE_STORAGE_KEYS,
  ...Object.values(PREF_KEYS),
  DEVICE_KEYS.unresolvedPayments,
])

/**
 * Deletes the wallet state older builds kept here, cached master key included: the wallet families
 * at the top level and in every partition (except `rollup`'s live relay entries), their
 * import markers and wagmi's old store; with `names`, only those keys, wherever they sit. Device
 * and third-party keys stay. A key that cannot be removed does not stop the rest; the first failure
 * is thrown once they have been tried.
 */
export function removeOldWalletKeys(rollup: string, names?: readonly string[]): void {
  if (typeof localStorage === "undefined") return
  const store = localStorage
  const relay = `${PREFIX}${rollup}.${RELAY_FAMILY}`
  const keys = Object.keys(store)
  const expired = expiredRelays(store, keys, relay)
  let failed: { error: unknown } | undefined
  for (const key of keys) {
    if (!isOldWalletKey(key, relay, expired) || (names && !names.includes(nameOf(key)))) continue
    try {
      store.removeItem(key)
    } catch (error) {
      failed ??= { error }
    }
  }
  if (failed) throw failed.error
}

/** A key's name without its `rollup.<version>.` prefix. */
const nameOf = (key: string) =>
  key.startsWith(PREFIX) ? key.slice(key.indexOf(".", PREFIX.length) + 1) : key

/** The relay attempts whose result is past its timeout or unreadable, by state. */
function expiredRelays(store: Storage, keys: readonly string[], relay: string): Set<string> {
  const results = `${relay}:`
  const expired = new Set<string>()
  for (const key of keys) {
    if (!key.startsWith(results)) continue
    let createdAt: unknown
    try {
      createdAt = (JSON.parse(store.getItem(key) ?? "null") as { createdAt?: unknown })?.createdAt
    } catch {
      createdAt = undefined
    }
    const fresh = typeof createdAt === "number" && Date.now() - createdAt <= RELAY_TIMEOUT_MS
    if (!fresh) expired.add(key.slice(results.length))
  }
  return expired
}

function isOldWalletKey(key: string, relay: string, expired: ReadonlySet<string>): boolean {
  if (key.startsWith("zkm_wallet_imported.") || key === "wagmi.store") return true
  if (key.startsWith(relay)) return expired.has(key.slice(key.indexOf(":") + 1))
  if (KEPT.has(key)) return false
  return OLD_WALLET_FAMILIES.some((family) => nameOf(key).startsWith(family))
}
