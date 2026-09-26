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

// User-overridable endpoints, one entry per key: env var > endpoints.json in the
// user-data dir > nothing (the bundle/config default applies). Kept deliberately
// narrow — only endpoints that don't define trust anchors belong here: node and
// L1 RPC are state views, the enclave target is transport (the TEE must still
// pass attestation). The config-profile and oxide-manifest URLs stay
// non-editable: the profile is the wallet's address authority, and an editable
// pointer would swap that authority rather than retarget a state view.
const ENDPOINT_KEYS = Object.freeze({
  l1RpcUrl: "OBSIDION_L1_RPC_URL",
  nodeUrl: "OBSIDION_NODE_URL",
  enclaveUrl: "OBSIDION_ENCLAVE_TARGET",
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
  return value
}

// Returns { endpoints, sources } where sources[key] is "env" | "file" | null —
// the settings page shows provenance so an incident responder can see which
// config is actually in force.
function loadEndpoints(endpointsFilePath) {
  let fileValues = {}
  if (endpointsFilePath && fs.existsSync(endpointsFilePath)) {
    try {
      fileValues = readJson(endpointsFilePath)
    } catch (error) {
      throw new Error(`Unreadable endpoints file ${endpointsFilePath}: ${error.message}`)
    }
  }
  const endpoints = {}
  const sources = {}
  for (const [key, envName] of Object.entries(ENDPOINT_KEYS)) {
    if (process.env[envName]) {
      endpoints[key] = validateEndpointUrl(key, process.env[envName])
      sources[key] = "env"
    } else if (typeof fileValues[key] === "string" && fileValues[key].length > 0) {
      endpoints[key] = validateEndpointUrl(key, fileValues[key])
      sources[key] = "file"
    } else {
      sources[key] = null
    }
  }
  return { endpoints, sources }
}

// Validates and persists user overrides. Unknown keys are dropped; an empty or
// missing value clears the override (the baked value applies again).
function saveEndpoints(endpointsFilePath, values) {
  const toWrite = {}
  for (const key of Object.keys(ENDPOINT_KEYS)) {
    const value = values?.[key]
    if (typeof value === "string" && value.trim().length > 0) {
      toWrite[key] = validateEndpointUrl(key, value.trim())
    }
  }
  const tempPath = `${endpointsFilePath}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(toWrite, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
  fs.renameSync(tempPath, endpointsFilePath)
  return toWrite
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
  // OBSIDION_ENCLAVE_TARGET is handled by the endpoints system (loadEndpoints),
  // which main.js applies onto the proxy table alongside user overrides.

  config.hostname = validateHostname(config.hostname)
  config.passkeyRpId = validateHostname(config.passkeyRpId)
  if (fs.existsSync(metadataPath)) {
    const metadata = readJson(metadataPath)
    if (metadata.pageHostname !== config.hostname || metadata.passkeyRpId !== config.passkeyRpId) {
      throw new Error("Launcher hostname or RP differs from the bundled wallet; rebuild for this environment")
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
  ENDPOINT_KEYS,
  loadConfig,
  loadEndpoints,
  normalizeStartPath,
  saveEndpoints,
  validateEndpointUrl,
  validateHostname,
  validateProxies,
}
