/**
 * What the desktop launcher tells its settings page, injected as `window.__ZKMONEY_DESKTOP_SETTINGS__`
 * on that path only. The token authorizes the page's saves; nothing here is an endpoint.
 */
export type ConfigKey = "configProfileUrl" | "bootFromBakedProfile"

export interface ConfigValues {
  configProfileUrl?: string
  bootFromBakedProfile?: boolean
}

export interface BakedStamp {
  current: string
  publishedAt: string
  expiresAt?: string
}

export interface DesktopSettingsState {
  token: string
  values: ConfigValues
  /** "env" when an environment variable sets the value, which then outranks a save. */
  sources: Partial<Record<ConfigKey, string | null>>
  /** Values ignored at startup; `key` is null for an unreadable settings file. */
  problems: { key: ConfigKey | null; source: string; message: string }[]
  builtAt?: string
  profile: { url: string | null; overridden: boolean; baked: BakedStamp | null }
  profileProbe: {
    state: "ok" | "rejected" | "unreachable"
    detail?: string | null
    overridden?: boolean
    bakedExpired?: boolean
  } | null
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => !!value && typeof value === "object"
const text = (value: unknown) => (typeof value === "string" ? value : undefined)
const flag = (value: unknown) => (typeof value === "boolean" ? value : undefined)
const isConfigKey = (value: unknown): value is ConfigKey =>
  value === "configProfileUrl" || value === "bootFromBakedProfile"

function readValues(raw: unknown): ConfigValues {
  if (!isObject(raw)) return {}
  const values: ConfigValues = {}
  const url = text(raw.configProfileUrl)
  if (url) values.configProfileUrl = url
  if (raw.bootFromBakedProfile === true) values.bootFromBakedProfile = true
  return values
}

function readSources(raw: unknown): DesktopSettingsState["sources"] {
  if (!isObject(raw)) return {}
  const sources: DesktopSettingsState["sources"] = {}
  for (const key of ["configProfileUrl", "bootFromBakedProfile"] as const) {
    const source = text(raw[key])
    if (source) sources[key] = source
  }
  return sources
}

function readProblems(raw: unknown): DesktopSettingsState["problems"] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((problem) => {
    if (!isObject(problem)) return []
    const message = text(problem.message)
    const key = problem.key === null ? null : isConfigKey(problem.key) ? problem.key : undefined
    if (message === undefined || key === undefined) return []
    return [{ key, source: text(problem.source) ?? "file", message }]
  })
}

function readBaked(raw: unknown): BakedStamp | null {
  if (!isObject(raw)) return null
  const current = text(raw.current)
  const publishedAt = text(raw.publishedAt)
  if (!current || !publishedAt) return null
  const expiresAt = text(raw.expiresAt)
  return { current, publishedAt, ...(expiresAt ? { expiresAt } : {}) }
}

function readProfile(raw: unknown): DesktopSettingsState["profile"] {
  if (!isObject(raw)) return { url: null, overridden: false, baked: null }
  return {
    url: text(raw.url) ?? null,
    overridden: raw.overridden === true,
    baked: readBaked(raw.baked),
  }
}

function readProbe(raw: unknown): DesktopSettingsState["profileProbe"] {
  if (!isObject(raw)) return null
  const state = raw.state
  if (state !== "ok" && state !== "rejected" && state !== "unreachable") return null
  return {
    state,
    detail: text(raw.detail) ?? null,
    overridden: flag(raw.overridden),
    bakedExpired: flag(raw.bakedExpired),
  }
}

/** The launcher's state, field by field; null without a token, which is what saves need. */
export function readDesktopSettingsState(): DesktopSettingsState | null {
  const raw = (globalThis as { __ZKMONEY_DESKTOP_SETTINGS__?: unknown })
    .__ZKMONEY_DESKTOP_SETTINGS__
  if (!isObject(raw)) return null
  const token = text(raw.token)
  if (!token) return null
  return {
    token,
    values: readValues(raw.values),
    sources: readSources(raw.sources),
    problems: readProblems(raw.problems),
    builtAt: text(raw.builtAt),
    profile: readProfile(raw.profile),
    profileProbe: readProbe(raw.profileProbe),
  }
}
