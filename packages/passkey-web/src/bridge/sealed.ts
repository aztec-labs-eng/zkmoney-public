/**
 * The sealed hand-off: the campaign seals a `BridgeMessage` under a fresh AES-GCM key, puts the
 * ciphertext in the wallet URL's fragment and the key in a short-lived cookie on the domain both
 * hosts share. Neither half alone reveals the material. It works where the storage bridge cannot:
 * WebKit splits a frame's storage by top-level origin, but not a top-level page's same-site cookie.
 */
import { base64UrlToBytes, bytesToBase64Url } from "../ceremony/bytes.js"

export const HANDOFF_COOKIE = "zkm_handoff"
/** Fragment parameter carrying `<handoff id>.<ciphertext>`. */
export const HANDOFF_FRAGMENT_PARAM = "h"
/** Matches the wallet's ten-minute age bound on the material. */
export const HANDOFF_COOKIE_MAX_AGE_S = 600

const IV_BYTES = 12

export async function sealHandoff(message: unknown): Promise<{ key: string; sealed: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"])
  const plaintext = new TextEncoder().encode(JSON.stringify(message))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext))
  const out = new Uint8Array(IV_BYTES + ct.length)
  out.set(iv)
  out.set(ct, IV_BYTES)
  return { key: bytesToBase64Url(raw), sealed: bytesToBase64Url(out) }
}

/** The parsed plaintext, or null for a wrong key, tampered ciphertext, or anything malformed. */
export async function openHandoff(key: string, sealed: string): Promise<unknown | null> {
  try {
    const raw = base64UrlToBytes(key)
    const bytes = base64UrlToBytes(sealed)
    if (raw.length !== 32 || bytes.length <= IV_BYTES) return null
    const k = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"])
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
      k,
      bytes.slice(IV_BYTES),
    )
    return JSON.parse(new TextDecoder().decode(pt))
  } catch {
    return null
  }
}

/**
 * The cookie `Domain` both hosts can read: "" for one host (a local pair on two ports; cookies
 * ignore the port), the longest shared suffix of two or more labels otherwise, null when there is
 * none. A public suffix passes here and the browser drops the cookie; the hand-off then falls back.
 */
export function sharedCookieDomain(hostA: string, hostB: string): string | null {
  if (hostA === hostB) return ""
  const a = hostA.split(".").reverse()
  const b = hostB.split(".").reverse()
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n >= 2 ? a.slice(0, n).reverse().join(".") : null
}

/** IDs come from randomUUID on each click; reject cookie-name metacharacters from URLs. */
export const isHandoffId = (id: string): boolean =>
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)

/** `__Secure-` keeps a plain-http host from writing it. Each click owns a separate cookie. */
export function handoffCookieName(secure: boolean, id: string): string {
  if (!isHandoffId(id)) throw new Error("Invalid handoff id")
  return `${secure ? "__Secure-" : ""}${HANDOFF_COOKIE}_${id}`
}

/** A `document.cookie` assignment for the key; `maxAge` 0 deletes it. */
export function handoffCookie(
  value: string,
  domain: string,
  secure: boolean,
  id: string,
  maxAge = HANDOFF_COOKIE_MAX_AGE_S,
): string {
  return [
    `${handoffCookieName(secure, id)}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Strict",
    ...(domain ? [`Domain=${domain}`] : []),
    ...(secure ? ["Secure"] : []),
  ].join("; ")
}

export function readHandoffCookie(cookies: string, secure: boolean, id: string): string | null {
  const name = handoffCookieName(secure, id)
  for (const part of cookies.split(";")) {
    const [n, value] = part.trim().split("=")
    if (n === name && value) return value
  }
  return null
}
