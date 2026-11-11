/**
 * Local settings and preferences from a retired rollup's database. A move to a new rollup opens an
 * empty wallet database, which would ask the analytics question again, turn non-contact requests
 * back on and forget this browser's preferences.
 */
import {
  CONFIG_STORAGE_KEY_PREFIX,
  LOCAL_CONFIG_DEFAULTS,
  type LocalConfig,
} from "@obsidion/core/constants"
import type { Database } from "@obsidion/front-core"
import { PREF_KEYS, readsPref } from "./deviceKeys"
import { WEB_STORAGE_PREFIX } from "./storageKeys"
import { readEntriesFromOtherDatabases } from "./walletStorage"

/** What a setting takes when retired databases disagree: the answer that shares the least. */
const ON_DISAGREEMENT: LocalConfig = {
  analyticsConsent: false,
  allowNonContactRequests: false,
}

const SETTINGS = Object.keys(LOCAL_CONFIG_DEFAULTS) as (keyof LocalConfig)[]
const PREFS: readonly string[] = Object.values(PREF_KEYS)
const storageKey = (setting: keyof LocalConfig) =>
  WEB_STORAGE_PREFIX + CONFIG_STORAGE_KEY_PREFIX + setting

/** What a preference takes when retired databases disagree, where one answer is the private one. */
const PREF_ON_DISAGREEMENT: Readonly<Record<string, string>> = { [PREF_KEYS.hideBalances]: "true" }

/**
 * Copies the retired databases' settings into this rollup's database while it holds none, and each
 * preference while it holds none of that one, before device state loads. Never throws: what is not
 * carried keeps its default, and a later boot tries again.
 */
export async function carryRetiredConfig(db: Database): Promise<void> {
  try {
    const settingKeys = SETTINGS.map(storageKey)
    const saved = await db.getMany([...settingKeys, ...PREFS])
    const settingsHeld = saved.slice(0, settingKeys.length).some((v) => v !== undefined)
    const prefs = PREFS.filter((_, i) => saved[settingKeys.length + i] === undefined)
    if (settingsHeld && prefs.length === 0) return
    const retired = await readEntriesFromOtherDatabases([
      ...(settingsHeld ? [] : settingKeys),
      ...prefs,
    ])
    const ops: [string, string][] = []
    for (const setting of settingsHeld ? [] : SETTINGS) {
      const values = new Set(
        retired.map((entries) => decode(setting, entries.get(storageKey(setting)))),
      )
      values.delete(undefined)
      if (values.size === 0) continue
      const value = values.size === 1 ? [...values][0] : ON_DISAGREEMENT[setting]
      ops.push([storageKey(setting), JSON.stringify(value)])
    }
    for (const key of prefs) {
      const values = new Set(
        retired.flatMap((entries) => entries.get(key) ?? []).filter((raw) => readsPref(key, raw)),
      )
      const [raw] = values
      const value =
        values.size === 1 ? raw : values.size > 1 ? PREF_ON_DISAGREEMENT[key] : undefined
      if (value !== undefined) ops.push([key, value])
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
