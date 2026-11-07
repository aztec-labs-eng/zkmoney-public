/**
 * Local settings from a retired rollup's database. A move to a new rollup opens an empty wallet
 * database, which would ask the analytics question again and turn non-contact requests back on.
 */
import {
  CONFIG_STORAGE_KEY_PREFIX,
  LOCAL_CONFIG_DEFAULTS,
  type LocalConfig,
} from "@obsidion/core/constants"
import type { Database } from "@obsidion/front-core"
import { WEB_STORAGE_PREFIX } from "./storageKeys"
import { readEntriesFromOtherDatabases } from "./walletStorage"

/** What a setting takes when retired databases disagree: the answer that shares the least. */
const ON_DISAGREEMENT: LocalConfig = {
  analyticsConsent: false,
  allowNonContactRequests: false,
}

const SETTINGS = Object.keys(LOCAL_CONFIG_DEFAULTS) as (keyof LocalConfig)[]
const storageKey = (setting: keyof LocalConfig) =>
  WEB_STORAGE_PREFIX + CONFIG_STORAGE_KEY_PREFIX + setting

/**
 * Copies the retired databases' settings into this rollup's database while it holds none, before
 * the app reads them. Never throws: a setting that is not carried keeps its default.
 */
export async function carryRetiredConfig(db: Database): Promise<void> {
  try {
    if ((await db.getMany(SETTINGS.map(storageKey))).some((v) => v !== undefined)) return
    const retired = await readEntriesFromOtherDatabases(SETTINGS.map(storageKey))
    const ops: [string, string][] = []
    for (const setting of SETTINGS) {
      const values = new Set(
        retired.map((entries) => decode(setting, entries.get(storageKey(setting)))),
      )
      values.delete(undefined)
      if (values.size === 0) continue
      const value = values.size === 1 ? [...values][0] : ON_DISAGREEMENT[setting]
      ops.push([storageKey(setting), JSON.stringify(value)])
    }
    if (ops.length > 0)
      await db.write(async (w) => ops.forEach(([key, value]) => w.put(key, value)))
  } catch (e) {
    console.warn("[retiredConfig] could not carry retired settings:", e)
  }
}

function decode(setting: keyof LocalConfig, raw: string | undefined): unknown {
  if (raw === undefined) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === typeof LOCAL_CONFIG_DEFAULTS[setting] ? value : undefined
  } catch {
    return undefined
  }
}
