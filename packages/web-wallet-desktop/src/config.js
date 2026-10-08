"use strict"

const fs = require("node:fs")
const path = require("node:path")

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function normalizeStartPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "/"
  }
  return value.startsWith("/") ? value : `/${value}`
}

// "localhost" selects the sandbox dev mode: no host-resolver mapping, Chrome opens
// https://localhost:<port> directly (already a valid passkey RP).
function validateHostname(hostname) {
  if (typeof hostname === "string" && hostname.toLowerCase() === "localhost") {
    return "localhost"
  }
  if (
    typeof hostname !== "string" ||
    hostname.length === 0 ||
    hostname.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(
      hostname,
    )
  ) {
    throw new Error(`Invalid hostname: ${String(hostname)}`)
  }
  return hostname.toLowerCase()
}

// User-overridable settings, one entry per key: env var > endpoints.json in the
// user-data dir > nothing (the bundle/config default applies). Endpoints are not
// among them: the wallet keeps its own.
//
// `configProfileUrl` is the dangerous one: the profile names every contract
// address the wallet talks to, documents carry no signature, and the checks that
// survive an override (profile id, network, schema, expiry, the wallet's own
// mainnet policy) are format checks any author can satisfy. A hostile document
// therefore routes funds to hostile contracts. It is exposed anyway so a user is
// never stranded by a profile nobody serves, and the UI carries the warning.
// `bootFromBakedProfile` is the safe way past the same outage: the copy the
// release shipped with, supplied by nobody.
//
// The oxide manifest URL stays non-editable — it rides inside the profile
// version, where the enclave URL, portal and measurement are bound together.
const SETTING_KEYS = Object.freeze({
  configProfileUrl: { envName: "OBSIDION_CONFIG_PROFILE_URL", kind: "url" },
  bootFromBakedProfile: { envName: "OBSIDION_BOOT_FROM_BAKED_PROFILE", kind: "flag" },
})

// Returns the input verbatim (trimmed by callers) — URL.toString() would append a
// trailing slash to bare origins, which some RPC clients mis-join.
function validateEndpointUrl(key, value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${key} is not a valid URL: ${String(value)}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${key} must be http(s): ${String(value)}`)
  }
  // `https:host/…` parses here, but a browser fetch resolves it against the page's own origin.
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`${key} must start with http:// or https://: ${String(value)}`)
  }
  return value
}

// The shape artifact addresses derive from; the wallet refuses a profile URL without it at boot.
const PROFILE_PATH =
  /^\/profiles\/v[1-9]\d*\/(current|(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))\.json$/

function validateProfileUrlShape(key, value) {
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !PROFILE_PATH.test(url.pathname)
  ) {
    throw new Error(
      `${key} must be https://<host>/profiles/<generation>/<current or x.y.z>.json: ${String(
        value,
      )}`,
    )
  }
  return value
}

const FLAG_ON = new Set(["true", "1", "on", "yes"])
const FLAG_OFF = new Set(["false", "0", "off", "no"])

// A flag is on, explicitly off, or unset. The JSON booleans come from the settings page; the
// spellings come from the environment or a hand-edited file. Explicit off exists so the environment
// can win over a saved on, the way it can replace any saved URL.
function parseFlag(key, raw) {
  if (raw === true || raw === false) return raw
  if (typeof raw !== "string") return undefined
  const value = raw.trim().toLowerCase()
  if (value.length === 0) return undefined
  if (FLAG_ON.has(value)) return true
  if (FLAG_OFF.has(value)) return false
  throw new Error(`${key} must be one of true/false, 1/0, on/off, yes/no: ${String(raw)}`)
}

// Returns the value a setting takes from `raw`: undefined when unset; for a flag, false when
// explicitly off. `profileShape` holds the profile URL to the shape the wallet requires outside
// sandbox builds.
function normalizeSetting(key, raw, { profileShape = false } = {}) {
  const { kind } = SETTING_KEYS[key]
  if (kind === "flag") return parseFlag(key, raw)
  if (typeof raw !== "string") return undefined
  const value = raw.trim()
  if (value.length === 0) return undefined
  validateEndpointUrl(key, value)
  return profileShape ? validateProfileUrlShape(key, value) : value
}

// Returns { endpoints, sources, problems }. sources[key] is "env" | "file" | null — the settings
// page shows provenance so an incident responder can see which config is actually in force.
// A value that fails validation is reported in `problems` ({ key, source, message }; key null for
// an unreadable file) and skipped, so one typo never discards every other setting. Keys outside
// SETTING_KEYS are ignored.
function loadEndpoints(endpointsFilePath, rules = {}) {
  const problems = []
  let fileValues = {}
  if (endpointsFilePath && fs.existsSync(endpointsFilePath)) {
    try {
      fileValues = readJson(endpointsFilePath)
    } catch (error) {
      problems.push({
        key: null,
        source: "file",
        message: `Unreadable settings file ${endpointsFilePath}: ${error.message}`,
      })
    }
  }
  const attempt = (key, source, raw) => {
    try {
      return normalizeSetting(key, raw, rules)
    } catch (error) {
      problems.push({ key, source, message: error.message })
      return undefined
    }
  }
  const endpoints = {}
  const sources = {}
  // The environment wins whenever it says anything, an explicit off included, which is what lets
  // the settings page warn that a saved value is being overridden.
  for (const [key, { envName }] of Object.entries(SETTING_KEYS)) {
    const fromEnv = attempt(key, "env", process.env[envName])
    const fromFile = fromEnv === undefined ? attempt(key, "file", fileValues[key]) : undefined
    if (fromEnv !== undefined) {
      if (fromEnv !== false) endpoints[key] = fromEnv
      sources[key] = "env"
    } else if (fromFile !== undefined && fromFile !== false) {
      endpoints[key] = fromFile
      sources[key] = "file"
    } else {
      sources[key] = null
    }
  }
  return { endpoints, sources, problems }
}

// Validates and persists user overrides. Unknown keys are dropped; an empty,
// missing or off value clears the override (the baked value applies again).
function saveEndpoints(endpointsFilePath, values, rules = {}) {
  const toWrite = {}
  for (const key of Object.keys(SETTING_KEYS)) {
    const value = normalizeSetting(key, values?.[key], rules)
    if (value !== undefined && value !== false) toWrite[key] = value
  }
  const tempPath = `${endpointsFilePath}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(toWrite, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
  fs.renameSync(tempPath, endpointsFilePath)
  return toWrite
}

// The wallet's __ZKMONEY_ENDPOINTS__. The switch wins over a URL: it boots without fetching.
function injectedEndpoints(endpoints) {
  if (endpoints.bootFromBakedProfile) return { bootFromBakedProfile: true }
  if (endpoints.configProfileUrl) return { configProfileUrl: endpoints.configProfileUrl }
  return {}
}

// The settings page's __ZKMONEY_DESKTOP_SETTINGS__.
function settingsPageState({ token, endpointState, builtAt, profile, profileProbe }) {
  return {
    token,
    values: endpointState.endpoints,
    sources: endpointState.sources,
    problems: endpointState.problems,
    builtAt,
    profile,
    profileProbe,
  }
}

function validateProxies(proxies) {
  if (proxies === undefined || proxies === null) {
    return {}
  }
  if (typeof proxies !== "object" || Array.isArray(proxies)) {
    throw new Error("proxies must be an object mapping path prefixes to target origins")
  }
  for (const [prefix, target] of Object.entries(proxies)) {
    if (!prefix.startsWith("/") || (prefix.endsWith("/") && prefix !== "/")) {
      throw new Error(`Proxy prefix must start with "/" and not end with "/": ${prefix}`)
    }
    let url
    try {
      url = new URL(target)
    } catch {
      throw new Error(`Proxy target for ${prefix} is not a valid URL: ${String(target)}`)
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Proxy target for ${prefix} must be http(s): ${String(target)}`)
    }
  }
  return proxies
}

function loadConfig(resourceRoot, metadataPath = path.join(resourceRoot, "build-meta.json")) {
  const defaultsPath = path.join(resourceRoot, "config", "default.json")
  const generatedPath = path.join(resourceRoot, "config", "generated.json")
  const config = readJson(fs.existsSync(generatedPath) ? generatedPath : defaultsPath)

  if (process.env.OBSIDION_LOCAL_HOSTNAME) {
    config.hostname = process.env.OBSIDION_LOCAL_HOSTNAME
  }
  if (process.env.OBSIDION_LOCAL_START_PATH) {
    config.startPath = process.env.OBSIDION_LOCAL_START_PATH
  }
  if (process.env.OBSIDION_LOCAL_TEST_TYPE === "0") {
    config.includeTestTypeFlag = false
  }
  // Developer-only: retargets a sandbox build's enclave proxy. A build without one has nothing to
  // retarget; the wallet dials the enclave its profile names.
  const enclaveTarget = process.env.OBSIDION_ENCLAVE_TARGET?.trim()
  if (enclaveTarget) {
    validateEndpointUrl("OBSIDION_ENCLAVE_TARGET", enclaveTarget)
    if (config.proxies?.["/svc/enclave"]) {
      config.proxies = { ...config.proxies, "/svc/enclave": enclaveTarget }
    }
  }

  config.hostname = validateHostname(config.hostname)
  config.passkeyRpId = validateHostname(config.passkeyRpId)
  if (fs.existsSync(metadataPath)) {
    const metadata = readJson(metadataPath)
    if (metadata.pageHostname !== config.hostname || metadata.passkeyRpId !== config.passkeyRpId) {
      throw new Error(
        "Launcher hostname or RP differs from the bundled wallet; rebuild for this environment",
      )
    }
  }
  config.startPath = normalizeStartPath(config.startPath)
  config.certificateDays = Number(config.certificateDays || 3650)
  // With a localhost hostname the port is part of the origin (and of the storage
  // partition), so it must be stable across launches; mapped hostnames sit behind
  // :443 and can take any free port. 0 = ephemeral.
  config.localPort = Number(config.localPort || 0)
  if (!Number.isInteger(config.localPort) || config.localPort < 0 || config.localPort > 65535) {
    throw new Error("localPort must be an integer in [0, 65535]")
  }
  config.spaFallback = config.spaFallback !== false
  config.proxies = validateProxies(config.proxies)

  if (config.contentSecurityPolicy !== null && config.contentSecurityPolicy !== undefined) {
    if (
      typeof config.contentSecurityPolicy !== "string" ||
      config.contentSecurityPolicy.length === 0
    ) {
      throw new Error("contentSecurityPolicy must be null or a non-empty string")
    }
  } else {
    config.contentSecurityPolicy = null
  }

  if (!Number.isInteger(config.certificateDays) || config.certificateDays < 1) {
    throw new Error("certificateDays must be a positive integer")
  }

  return Object.freeze(config)
}

module.exports = {
  SETTING_KEYS,
  injectedEndpoints,
  loadConfig,
  loadEndpoints,
  normalizeStartPath,
  saveEndpoints,
  settingsPageState,
  validateEndpointUrl,
  validateHostname,
  validateProxies,
}
