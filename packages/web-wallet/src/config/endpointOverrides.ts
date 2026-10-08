/**
 * Endpoint overrides the user saves in the endpoint editor — the Aztec node with an optional API
 * key, the L1 RPC and the enclave — one device-scoped storage record, in this browser only. Config
 * resolution reads it at boot, on web and desktop alike.
 */
import { sha256 } from "@noble/hashes/sha2"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils"
import { deviceStorage } from "../platform/storage/rollupStorage"

export type EndpointKind = "node" | "l1Rpc" | "enclave"
/** A key is only ever stored and read beside the node URL it was saved with. */
export type EndpointOverrides = Partial<Record<EndpointKind, string>> & { nodeApiKey?: string }
/** What the editor submits; an empty value means no override. */
export type EndpointValues = Record<EndpointKind, string> & { nodeApiKey?: string }

const KINDS: EndpointKind[] = ["node", "l1Rpc", "enclave"]
const STORAGE_KEY = "webwallet.endpoints"

/**
 * What routes: an absolute http(s) URL as WHATWG parsing serializes it (host lower-cased, implicit
 * port dropped, IDN as punycode, an empty query kept as its `?`), fragment dropped, embedded
 * credentials refused. The scheme must come with its `//`: `https:host/rpc` parses as an
 * authority here but `fetch` resolves it against the page. Used for default-equality and the
 * digest only — the URL the wallet dials is the input as typed.
 */
export function normalizeEndpoint(url: string): string {
  if (!/^https?:\/\//i.test(url)) throw new Error("Endpoint must start with http:// or https://")
  const parsed = new URL(url)
  if (parsed.username || parsed.password) {
    throw new Error("Endpoint must not embed credentials")
  }
  parsed.hash = ""
  return parsed.href
}

/** The normalized endpoint, or undefined when `url` is not one (`""`, a proxy path like `/svc/enclave`). */
export function tryNormalizeEndpoint(url: string): string | undefined {
  try {
    return normalizeEndpoint(url)
  } catch {
    return undefined
  }
}

/** 128 bits of SHA-256 over a normalized endpoint, as hex: the per-node suffix for the PXE store and scan cursors. */
export function endpointDigest(normalized: string): string {
  return bytesToHex(sha256(utf8ToBytes(normalized))).slice(0, 32)
}

/**
 * The storable form of a typed override: trimmed, an absolute http(s) URL without credentials.
 * The wallet appends `/rpc` to the enclave, so that one also refuses a query, a fragment or the
 * `/rpc` path itself, and drops trailing slashes.
 */
export function storableOverride(kind: EndpointKind, input: string): string | undefined {
  const url = input.trim()
  if (tryNormalizeEndpoint(url) === undefined) return undefined
  if (kind !== "enclave") return url
  if (/[?#]/.test(url)) return undefined
  const base = url.replace(/\/+$/, "")
  return /\/rpc$/i.test(base) ? undefined : base
}

/** The storable form of a typed node API key: trimmed, visible ASCII only, at most 512 characters. */
export function storableApiKey(input: string): string | undefined {
  const key = input.trim()
  return /^[\x21-\x7e]{1,512}$/.test(key) ? key : undefined
}

/**
 * The stored overrides. A record that does not parse, a value that no longer validates and a
 * storage failure all read as none.
 */
export function readEndpointOverrides(): EndpointOverrides {
  try {
    const raw = deviceStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const record: unknown = JSON.parse(raw)
    if (typeof record !== "object" || record === null) return {}
    const overrides: EndpointOverrides = {}
    for (const kind of KINDS) {
      const value = (record as Record<string, unknown>)[kind]
      const url = typeof value === "string" ? storableOverride(kind, value) : undefined
      if (url !== undefined) overrides[kind] = url
    }
    const key = (record as Record<string, unknown>).nodeApiKey
    const apiKey = typeof key === "string" ? storableApiKey(key) : undefined
    if (overrides.node !== undefined && apiKey !== undefined) overrides.nodeApiKey = apiKey
    return overrides
  } catch {
    return {}
  }
}

export type EndpointWriteResult =
  | { ok: true }
  | { ok: false; reason: "invalid"; kind: EndpointKind | "nodeApiKey" }
  | { ok: false; reason: "changed" }
  | { ok: false; reason: "storage" }

export const sameOverrides = (a: EndpointOverrides, b: EndpointOverrides) =>
  KINDS.every((kind) => a[kind] === b[kind]) && a.nodeApiKey === b.nodeApiKey

/**
 * Replaces the record with `next` (an empty value means no override) in one write, then reads it
 * back — a refused save changes nothing. `seen` is the record the caller edited from: one another
 * tab changed since is refused, not overwritten. Callers reload the wallet only on `ok`.
 */
export function writeEndpointOverrides(
  next: EndpointValues,
  seen: EndpointOverrides,
): EndpointWriteResult {
  const record: EndpointOverrides = {}
  for (const kind of KINDS) {
    if (next[kind].trim() === "") continue
    const url = storableOverride(kind, next[kind])
    if (url === undefined) return { ok: false, reason: "invalid", kind }
    record[kind] = url
  }
  if ((next.nodeApiKey ?? "").trim() !== "") {
    const apiKey = storableApiKey(next.nodeApiKey!)
    if (record.node === undefined || apiKey === undefined) {
      return { ok: false, reason: "invalid", kind: "nodeApiKey" }
    }
    record.nodeApiKey = apiKey
  }
  try {
    if (!sameOverrides(readEndpointOverrides(), seen)) return { ok: false, reason: "changed" }
    if (Object.keys(record).length === 0) deviceStorage.removeItem(STORAGE_KEY)
    else deviceStorage.setItem(STORAGE_KEY, JSON.stringify(record))
    return sameOverrides(readEndpointOverrides(), record)
      ? { ok: true }
      : { ok: false, reason: "storage" }
  } catch {
    return { ok: false, reason: "storage" }
  }
}

/** Removes the record and reads back; false when it is still there or the storage refused. */
export function clearAllEndpointOverrides(): { ok: boolean } {
  try {
    deviceStorage.removeItem(STORAGE_KEY)
    return { ok: deviceStorage.getItem(STORAGE_KEY) === null }
  } catch {
    return { ok: false }
  }
}
