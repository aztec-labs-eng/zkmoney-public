// Optional HTTP basic auth for the vite dev/preview server, on when a user is configured (empty
// counts as unset): `BASIC_AUTH_USER=… BASIC_AUTH_PASS=… pnpm preview` rehearses the challenge the
// deployed CDN applies in its viewer-request function (credential in the distribution's
// KeyValueStore — see iac/modules/app-tier/modules/web-wallet).
//
// packages/web-faucet carries its own copy of the same primitive (independent Vercel project).
import { createHash } from "node:crypto"

export type BasicAuthVerdict = "off" | "ok" | "challenge"

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

export function checkBasicAuth(
  authorizationHeader: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): BasicAuthVerdict {
  const user = env.BASIC_AUTH_USER || ""
  if (!user) return "off"
  const pass = env.BASIC_AUTH_PASS || ""

  if (authorizationHeader?.startsWith("Basic ")) {
    try {
      const decoded = atob(authorizationHeader.slice(6))
      const sep = decoded.indexOf(":")
      if (
        sep !== -1 &&
        safeEqual(decoded.slice(0, sep), user) &&
        safeEqual(decoded.slice(sep + 1), pass)
      ) {
        return "ok"
      }
    } catch {
      // malformed base64
    }
  }
  return "challenge"
}

export const BASIC_AUTH_CHALLENGE = 'Basic realm="zk.money wallet"'

// A shared link lands in a chat as /link#… or /request#…; the crawler behind the card fetches the
// path alone and cannot answer a challenge, as does a wallet app fetching the WalletConnect icon.
// The two pages and both images are public to GET and HEAD, as on the CDN. Exact paths: nothing
// under them, and /claim stays gated.
const LINK_PREVIEW_PATHS = new Set(["/og.png", "/favicon.png", "/link", "/request"])

/** Whether the request is served without a credential: a link preview or the wallet icon. */
export function isPublicPath(method: string | undefined, path: string): boolean {
  return (method === "GET" || method === "HEAD") && LINK_PREVIEW_PATHS.has(path)
}

// Same name and attributes as the CDN's cookie (function/viewer-response.js beside the
// viewer-request function).
export const BASIC_AUTH_COOKIE = "__Host-basic-auth"
const REMEMBER_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000"

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=")
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

// Browsers drop basic-auth credentials when they quit, so the CDN answers a header login with a
// long-lived cookie it accepts on its own; this rehearses that. `setCookie` is set when the cookie
// needs issuing. The token derives from the credentials, so changing them revokes it.
export function gateBasicAuth(
  headers: { authorization?: string; cookie?: string },
  env: Record<string, string | undefined> = process.env,
): { verdict: BasicAuthVerdict; setCookie?: string } {
  const user = env.BASIC_AUTH_USER || ""
  if (!user) return { verdict: "off" }
  const token = createHash("sha256")
    .update(`${BASIC_AUTH_COOKIE}:${user}:${env.BASIC_AUTH_PASS || ""}`)
    .digest("hex")
  const remembered = cookieValue(headers.cookie, BASIC_AUTH_COOKIE)
  if (remembered !== undefined && safeEqual(remembered, token)) return { verdict: "ok" }
  if (checkBasicAuth(headers.authorization, env) !== "ok") return { verdict: "challenge" }
  return { verdict: "ok", setCookie: `${BASIC_AUTH_COOKIE}=${token}; ${REMEMBER_ATTRIBUTES}` }
}
