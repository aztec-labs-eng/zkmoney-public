/**
 * This browser's device keys: the session tuple, the passkey identity map, the local settings and
 * the e2e build's create request. They sit beside the accounts' namespaces in the
 * rollup's wallet database and keep the keys older builds wrote. Writes commit through the page's
 * `Database`, so a failed write rejects and changes nothing.
 */
import {
  CONFIG_STORAGE_KEY_PREFIX,
  LOCAL_CONFIG_DEFAULTS,
  type LocalConfig,
} from "@obsidion/core/constants"
import { memoryStore, type Database, type ReadonlyStore, type Write } from "@obsidion/front-core"
import { PASSKEY_IDENTITY_MAP_KEY, WEB_STORAGE_PREFIX } from "./storageKeys"

const setting = (key: keyof LocalConfig) => WEB_STORAGE_PREFIX + CONFIG_STORAGE_KEY_PREFIX + key

export const DEVICE_KEYS = {
  storageId: "webwallet.storageId",
  credentialId: "webwallet.credentialId",
  msk: "webwallet.msk",
  passkeyMap: WEB_STORAGE_PREFIX + PASSKEY_IDENTITY_MAP_KEY,
  analyticsConsent: setting("analyticsConsent"),
  allowNonContactRequests: setting("allowNonContactRequests"),
  lastCreateRequest: "webwallet.e2e.lastCreateRequest",
} as const

export type DeviceKey = keyof typeof DEVICE_KEYS

/** Stages device keys in `w`; null removes one. */
export function stageDeviceKeys(w: Write, values: Partial<Record<DeviceKey, string | null>>): void {
  for (const [key, value] of Object.entries(values) as [DeviceKey, string | null][]) {
    if (value === null) w.remove(DEVICE_KEYS[key])
    else w.put(DEVICE_KEYS[key], value)
  }
}

/** Commits device keys as one transaction. */
export const writeDeviceKeys = (db: Database, values: Partial<Record<DeviceKey, string | null>>) =>
  db.write(async (w) => stageDeviceKeys(w, values))

/** Saves a local setting. */
export const saveSetting = <K extends keyof LocalConfig>(
  db: Database,
  key: K,
  value: LocalConfig[K],
) => writeDeviceKeys(db, { [key]: JSON.stringify(value) })

/** The device keys as saved; null for an absent key. */
type Saved = Record<DeviceKey, string | null>

const HELD = Object.keys(DEVICE_KEYS) as DeviceKey[]
const HELD_BY_KEY: ReadonlyMap<string, DeviceKey> = new Map(HELD.map((k) => [DEVICE_KEYS[k], k]))
const NOTHING_SAVED = Object.fromEntries(HELD.map((k) => [k, null])) as Saved

/** The device keys as saved, with the settings decoded. */
export type DeviceState = Omit<Saved, keyof LocalConfig> & {
  analyticsConsent: boolean
  /** The consent question was answered: a decline saves `false`. */
  consentAsked: boolean
  allowNonContactRequests: boolean
}

/** A saved setting, or its default when absent or of another type. */
function decode<K extends keyof LocalConfig>(key: K, raw: string | null): LocalConfig[K] {
  if (raw === null) return LOCAL_CONFIG_DEFAULTS[key]
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === typeof LOCAL_CONFIG_DEFAULTS[key]
      ? (value as LocalConfig[K])
      : LOCAL_CONFIG_DEFAULTS[key]
  } catch {
    return LOCAL_CONFIG_DEFAULTS[key]
  }
}

const stateOf = (saved: Saved): DeviceState => ({
  ...saved,
  analyticsConsent: decode("analyticsConsent", saved.analyticsConsent),
  consentAsked: saved.analyticsConsent !== null,
  allowNonContactRequests: decode("allowNonContactRequests", saved.allowNonContactRequests),
})

/** The page's device keys: read once by `load`, then kept current by each commit's writes. */
export interface Device extends ReadonlyStore<DeviceState> {
  /**
   * Reads the saved keys at its turn among the database's writes, so it sees every earlier commit
   * and a later one lands over it. The page awaits it once the wallet database opens.
   */
  load(): Promise<void>
}

export function deviceState(db: Database): Device {
  let saved = NOTHING_SAVED
  const state = memoryStore(stateOf(saved))
  db.onCommit((ops) => {
    const next = { ...saved }
    for (const [key, value] of ops) {
      const held = HELD_BY_KEY.get(key)
      if (held) next[held] = value
    }
    if (ops.some(([key]) => HELD_BY_KEY.has(key))) state.set(stateOf((saved = next)))
  })
  return {
    ...state.readonly,
    load: () =>
      db.write(async (w) => {
        const values = await w.getMany(HELD.map((k) => DEVICE_KEYS[k]))
        saved = Object.fromEntries(HELD.map((k, i) => [k, values[i] ?? null])) as Saved
        state.set(stateOf(saved))
      }),
  }
}
