/**
 * Handshake connect-link builder/parser plus the legacy bare-tag QR parsers. A leaf helper shared
 * by every QR display and scanner surface so they all use the same parser.
 */
import { Network } from "@obsidion/core/constants"

/**
 * Drop the scheme so the label under a QR reads as a friendly handle
 * rather than a URL.
 */
export function qrPayloadDisplayLabel(payload: string): string {
  return payload.replace(/^https?:\/\//, "")
}

/**
 * Parse a bare user tag out of a QR-code payload.
 *
 * The wallet's current QR encodes `https://<tag>.zk.money`, but we accept
 * several flavours so older QR codes and handles copied from chat keep
 * working:
 *
 *   • `https://<tag>.zk.money` / `http://<tag>.zk.money` — current form
 *     (with an optional trailing slash, query, or fragment).
 *   • `<tag>.zk.money` — bare host, no scheme. The pre-https build of
 *     the QR generator emitted handles in this shape.
 *   • `@<tag>.zk.money` — handle as displayed in chat / contacts.
 *   • `zkmoney/pay/me/<tag>` — legacy custom-scheme payload from an
 *     earlier build, kept here so older QRs still resolve.
 *
 * Tag chars match `normalizeTag` upstream (alphanum + `_-`). The result
 * is lowercased for canonical lookup against `ContactStorage`. Returns
 * `null` for anything unrecognized so the caller can ignore foreign QR
 * codes without crashing.
 */
export function parseUserTagFromQRPayload(payload: string): string | null {
  if (!payload) return null

  // Strip whitespace and a leading `@` so handles pasted from chat
  // ("@honk.zk.money") parse alongside QR URLs.
  const cleaned = payload.trim().replace(/^@/, "")

  // `<tag>.zk.money` with optional `https?://` prefix and trailing
  // slash / query / fragment. Unknown paths are not bare user tags.
  const hostMatch = cleaned.match(/^(?:https?:\/\/)?([a-z0-9_-]+)\.zk\.money\/?(?:[?#].*)?$/i)
  if (hostMatch) return hostMatch[1].toLowerCase()

  // Legacy custom-scheme payload from earlier builds.
  const legacyMatch = cleaned.match(/^zkmoney\/pay\/me\/([a-z0-9_-]+)$/i)
  if (legacyMatch) return legacyMatch[1].toLowerCase()

  return null
}

/**
 * Serverless inline-CBOR handshake link (QR / contact handshake, v2).
 *
 * Shape: `https://wallet.zk.money/connect#<packet>` — the web wallet's own origin, because the web
 * wallet is the only surface that handles `/connect`.
 *
 *   • `<packet>` — the WHOLE handshake packet, base64url-encoded CBOR
 *     (see `@obsidion/front-core` `encodeInline`). It rides ONLY in the
 *     hash fragment so it never reaches any web server (the fragment is
 *     not sent on an HTTP request); the scanner decodes it locally. The
 *     base64url alphabet (`A-Za-z0-9_-`) excludes `.` and `#`.
 *
 * There is no server, no handle/key split, and no decryption step — the fragment is a single
 * self-contained token carrying the sharer's identity, tag included. The host carries no identity.
 */
const CONNECT_TOKEN = /^[A-Za-z0-9_-]+$/

/** The registrable domain every handshake link is anchored on, as an origin. */
export const HANDSHAKE_LINK_HOST = "https://zk.money"

/**
 * The canonical web wallet origin for a network. Unlike a paylink, a connect link goes straight to
 * the wallet: `/connect` has no iOS handler to hand off to, so the paylink landing page would only
 * bounce it onward. Mirrors `paylinkLandingBaseUrl`'s prod/non-prod split.
 *
 * A deploy that knows its own origin should mint on that instead (see `mintableOrigin`) — a
 * staging or PR-preview build must hand out links back to ITSELF, and a preview host
 * (`wallet-pr-<n>.<zone>`) is not knowable at build time.
 */
export function walletBaseUrl(network: Network): string {
  return network === Network.MAINNET ? "https://wallet.zk.money" : "https://wallet.staging.zk.money"
}

/**
 * The origin to mint on for a build that has a real one: `origin` when a link built there would
 * survive `parseConnectLink`, else the network's canonical host. Defined against the parser itself
 * so the mint side can never emit a link the scan side rejects — which is what a bare
 * `location.origin` would do on localhost or the desktop launcher's loopback.
 */
export function mintableOrigin(origin: string | undefined, network: Network): string {
  const canMint = !!origin && parseConnectLink(buildHandshakeLink(origin, "AA")) !== null
  return canMint ? origin : walletBaseUrl(network)
}

/** `baseUrl` is the wallet origin the link is minted on — `walletBaseUrl(network)`. */
export function buildHandshakeLink(baseUrl: string, packet: string): string {
  return `${baseUrl.replace(/\/$/, "")}/connect#${packet}`
}

/**
 * Parse an inline handshake link into its packet token, or `null` for anything that is not a
 * well-formed `/connect#<packet>` link under `zk.money`.
 *
 * Strict on purpose: a plain `{tag}.zk.money` user link returns `null` here (no `/connect` path, no
 * fragment), so the scan handler can try this first and only fall back to the legacy bare-tag
 * parser — which otherwise greedily matches ANY `*.zk.money` URL — when this returns `null`.
 * Foreign hosts, a missing or empty fragment, and out-of-charset tokens all yield `null`. The
 * packet itself is NOT decoded here (that's the codec's job).
 *
 * Any subdomain under `zk.money` is accepted (`wallet.`, `wallet.staging.`, and the tag-host shape
 * older builds minted) but no label is ever READ: identity lives in the packet, so there is no
 * second tag source to reconcile. The registrable domain is the anti-spoof anchor and is never
 * loosened.
 */
export function parseConnectLink(payload: string): string | null {
  if (!payload) return null

  const cleaned = payload.trim().replace(/^@/, "")
  const match = cleaned.match(/^(?:https?:\/\/)?(?:[a-z0-9_-]+\.)*zk\.money\/connect#(.+)$/i)
  if (!match) return null

  // Reject an out-of-charset fragment so the codec only ever sees plausible input.
  return CONNECT_TOKEN.test(match[1]) ? match[1] : null
}
