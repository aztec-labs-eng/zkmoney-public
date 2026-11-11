/**
 * This browser's device keys: the session tuple, the passkey identity map, the local settings and
 * preferences, the ticket signups and spent tickets, the request payments held, and the e2e build's
 * create request and parked deposits. They sit beside the accounts' namespaces in the rollup's
 * wallet database and keep the keys older builds wrote. Writes commit through the page's
 * `Database`, so a failed write rejects and changes nothing.
 */
import {
  CONFIG_STORAGE_KEY_PREFIX,
  LOCAL_CONFIG_DEFAULTS,
  type LocalConfig,
} from "@obsidion/core/constants"
import { bestEffort } from "@obsidion/core/errors"
import { memoryStore, type Database, type ReadonlyStore, type Write } from "@obsidion/front-core"
import type { PasskeyEnvironment } from "@obsidion/passkey-web"
import { carryLocalPrefs } from "./storageMigrations/localPrefs"
import { dropOlderPayments, olderPayments, withOlder } from "./storageMigrations/olderPaymentHolds"
import { walletStoreIsPersistent } from "./walletStorage"
import { PASSKEY_IDENTITY_MAP_KEY, WEB_STORAGE_PREFIX } from "./storageKeys"

const setting = (key: keyof LocalConfig) => WEB_STORAGE_PREFIX + CONFIG_STORAGE_KEY_PREFIX + key

/** This browser's preferences, under the names older builds kept them by in `localStorage`. */
export const PREF_KEYS = {
  hideBalances: "webwallet.hide-balances",
  passkeyNames: "webwallet.passkey-names",
  passkeyEnv: "webwallet.passkeyEnv",
  localRefusals: "webwallet.local-refusals",
  hidePaylinkInfo: "webwallet.hide-paylink-info",
  ticketIntroSeen: "webwallet.ticket-intro-seen",
  localPasskeyHintShown: "webwallet.local-passkey-hint-shown",
} as const

export const DEVICE_KEYS = {
  storageId: "webwallet.storageId",
  credentialId: "webwallet.credentialId",
  msk: "webwallet.msk",
  passkeyMap: WEB_STORAGE_PREFIX + PASSKEY_IDENTITY_MAP_KEY,
  analyticsConsent: setting("analyticsConsent"),
  allowNonContactRequests: setting("allowNonContactRequests"),
  lastCreateRequest: "webwallet.e2e.lastCreateRequest",
  ticketSpent: "obsidion.ticket-spent",
  pendingDeposits: "webwallet.pendingDeposits",
  unresolvedPayments: "webwallet.unresolved-payments",
  lastDepositNetwork: "webwallet.deposit.lastNetwork",
  ...PREF_KEYS,
} as const

/** Request payments held, by `<network>:<payee>`: each may still be on its way. */
export type UnresolvedPayments = ReadonlyMap<string, { at: number; submission: string }>

/** A ticket signup's key: one per relying party and link. */
export const TICKET_SIGNUP_PREFIX = "obsidion.ticket-signup.account:"

export type DeviceKey = keyof typeof DEVICE_KEYS
type Pref = keyof typeof PREF_KEYS

/** The names this browser gave the account's passkeys, by public key. */
export type PasskeyNames = Readonly<Record<string, string>>

type Prefs = {
  hideBalances: boolean
  passkeyNames: PasskeyNames
  passkeyEnv: PasskeyEnvironment | null
  /** Sign-ups on this computer another manager's answer refused, since one was accepted. */
  localRefusals: number
  hidePaylinkInfo: boolean
  ticketIntroSeen: boolean
  /** Signature attempts the local passkey hint accompanied. */
  localPasskeyHintShown: number
}

const PREF_DEFAULTS: Prefs = {
  hideBalances: false,
  passkeyNames: {},
  passkeyEnv: null,
  localRefusals: 0,
  hidePaylinkInfo: false,
  ticketIntroSeen: false,
  localPasskeyHintShown: 0,
}

const flag = (raw: string) =>
  raw === "true" || raw === "1" ? true : raw === "false" ? false : undefined
const count = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : undefined)
function object(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
const names = (raw: string): PasskeyNames | undefined => {
  const saved = object(raw)
  return (
    saved &&
    Object.fromEntries(
      Object.entries(saved).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
      ),
    )
  )
}

/** Each preference read from its saved value; undefined for a value it cannot read. */
const READS: { [P in Pref]: (raw: string) => Prefs[P] | undefined } = {
  hideBalances: flag,
  passkeyNames: names,
  passkeyEnv: (raw) => object(raw) as PasskeyEnvironment | undefined,
  localRefusals: count,
  hidePaylinkInfo: flag,
  ticketIntroSeen: flag,
  localPasskeyHintShown: count,
}
const PREFS = Object.keys(PREF_KEYS) as Pref[]
const PREF_BY_KEY: ReadonlyMap<string, Pref> = new Map(PREFS.map((p) => [PREF_KEYS[p], p]))

/** Whether a preference's saved value reads. */
export const readsPref = (key: string, raw: string): boolean => {
  const pref = PREF_BY_KEY.get(key)
  return pref !== undefined && READS[pref](raw) !== undefined
}

/** Each preference as saved, or its default when absent or unreadable; the bytes stay either way. */
const prefsOf = (saved: Saved) =>
  Object.fromEntries(
    PREFS.map((p) => [p, (saved[p] === null ? undefined : READS[p](saved[p])) ?? PREF_DEFAULTS[p]]),
  ) as Prefs

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

/** Saves preferences; one that cannot be saved is logged and lost, never the caller's failure. */
export const savePrefs = (db: Database, prefs: Partial<Record<Pref, string>>) =>
  void bestEffort("unknown", writeDeviceKeys(db, prefs))

/**
 * Counts one more showing of the local passkey hint while it is below `max`, read and written in
 * one transaction so attempts close together each count. Resolves with the count before.
 */
export const countHintShowing = (db: Database, max: number): Promise<number> =>
  db.write(async (w) => {
    const shown = count((await w.get(PREF_KEYS.localPasskeyHintShown)) ?? "") ?? 0
    if (shown < max) w.put(PREF_KEYS.localPasskeyHintShown, String(shown + 1))
    return shown
  })

/**
 * Saves the passkey names `update` makes of the saved ones, read and written in one transaction so
 * renames close together each land. A failed save is logged and lost.
 */
export const updatePasskeyNames = (db: Database, update: (saved: PasskeyNames) => PasskeyNames) =>
  void bestEffort(
    "unknown",
    db.write(async (w) => {
      const saved = names((await w.get(PREF_KEYS.passkeyNames)) ?? "") ?? PREF_DEFAULTS.passkeyNames
      w.put(PREF_KEYS.passkeyNames, JSON.stringify(update(saved)))
    }),
  )

/**
 * Saves the refusal count `update` makes of the saved one, read and written in one transaction so
 * attempts close together each land. A failed save is logged and lost.
 */
export const updateLocalRefusals = (db: Database, update: (saved: number) => number) =>
  void bestEffort(
    "unknown",
    db.write(async (w) => {
      const saved = count((await w.get(PREF_KEYS.localRefusals)) ?? "") ?? 0
      const next = update(saved)
      if (next !== saved) w.put(PREF_KEYS.localRefusals, String(next))
    }),
  )

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
export type DeviceState = Omit<Saved, keyof LocalConfig | "unresolvedPayments" | Pref> &
  Prefs & {
    analyticsConsent: boolean
    /** The consent question was answered: a decline saves `false`. */
    consentAsked: boolean
    allowNonContactRequests: boolean
    /** The saved ticket signups, by key. */
    ticketSignups: ReadonlyMap<string, string>
    unresolvedPayments: UnresolvedPayments
    /** Set once `load` read the saved keys: before then nothing here is known. */
    loaded: boolean
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

/** Saved holds that do not parse hold nothing, as older builds read them. */
function payments(raw: string | null): UnresolvedPayments {
  try {
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    return new Map(parsed && typeof parsed === "object" ? Object.entries(parsed) : [])
  } catch {
    return new Map()
  }
}

const stateOf = (
  saved: Saved,
  ticketSignups: ReadonlyMap<string, string>,
  loaded: boolean,
): DeviceState => ({
  ...saved,
  ...prefsOf(saved),
  analyticsConsent: decode("analyticsConsent", saved.analyticsConsent),
  consentAsked: saved.analyticsConsent !== null,
  allowNonContactRequests: decode("allowNonContactRequests", saved.allowNonContactRequests),
  ticketSignups,
  unresolvedPayments: payments(saved.unresolvedPayments),
  loaded,
})

/** The page's device keys: read once by `load`, then kept current by each commit's writes. */
export interface Device extends ReadonlyStore<DeviceState> {
  /**
   * Reads the saved keys at its turn among the database's writes, so it sees every earlier commit
   * and a later one lands over it. The page awaits it once the wallet database opens.
   */
  load(): Promise<void>
}

/** `durable`: whether `db` outlives the page; only then does `load` drop what it carried. */
export function deviceState(db: Database, durable = walletStoreIsPersistent): Device {
  let saved = NOTHING_SAVED
  let signups: ReadonlyMap<string, string> = new Map()
  let loaded = false
  const state = memoryStore(stateOf(saved, signups, loaded))
  db.onCommit((ops) => {
    const next = { ...saved }
    const nextSignups = new Map(signups)
    let changed = false
    for (const [key, value] of ops) {
      const held = HELD_BY_KEY.get(key)
      if (held) next[held] = value
      else if (key.startsWith(TICKET_SIGNUP_PREFIX)) {
        if (value === null) nextSignups.delete(key)
        else nextSignups.set(key, value)
      } else continue
      changed = true
    }
    if (changed) state.set(stateOf((saved = next), (signups = nextSignups), loaded))
  })
  return {
    ...state.readonly,
    async load() {
      const older = olderPayments(DEVICE_KEYS.unresolvedPayments)
      let carried = false
      await db.write(async (w) => {
        const values = await w.getMany(HELD.map((k) => DEVICE_KEYS[k]))
        saved = Object.fromEntries(HELD.map((k, i) => [k, values[i] ?? null])) as Saved
        const absent = PREFS.filter((p) => saved[p] === null)
        const prefs = carryLocalPrefs(
          w,
          absent.map((p) => PREF_KEYS[p]),
          readsPref,
        )
        for (const p of absent) saved = { ...saved, [p]: prefs.get(PREF_KEYS[p]) ?? null }
        const merged = older === null ? undefined : withOlder(saved.unresolvedPayments, older)
        if (merged !== undefined) {
          carried = true
          if (merged !== null && merged !== saved.unresolvedPayments) {
            w.put(DEVICE_KEYS.unresolvedPayments, merged)
            saved = { ...saved, unresolvedPayments: merged }
          }
        }
        signups = new Map(await db.range(TICKET_SIGNUP_PREFIX))
        loaded = true
      })
      // Published once the read, and any carry, committed.
      state.set(stateOf(saved, signups, loaded))
      // An in-memory database forgets what it carried, so the older key stays for the next load.
      if (carried && durable()) dropOlderPayments(DEVICE_KEYS.unresolvedPayments)
    },
  }
}
