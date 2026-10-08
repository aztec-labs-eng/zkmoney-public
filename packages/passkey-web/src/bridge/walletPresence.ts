/**
 * Whether this browser's wallet holds an account or a registration under way, for a campaign page
 * on the shared domain: a returning user who already started in the wallet is sent back to it
 * instead of being asked to buy again. A bare flag, never the tag: every zk.money host receives
 * it, signed in or not. A cookie, not frame storage, for the reason in `sealed.ts`.
 */

export const WALLET_PRESENCE_COOKIE = "zkm_wallet"
/** The campaign session's lifetime; the wallet rewrites it on every boot. */
export const WALLET_PRESENCE_MAX_AGE_S = 7 * 24 * 60 * 60

function cookieName(secure: boolean): string {
  return `${secure ? "__Secure-" : ""}${WALLET_PRESENCE_COOKIE}`
}

/** A `document.cookie` assignment; `false` deletes it. */
export function walletPresenceCookie(present: boolean, domain: string, secure: boolean): string {
  return [
    `${cookieName(secure)}=${present ? "1" : ""}`,
    "Path=/",
    `Max-Age=${present ? WALLET_PRESENCE_MAX_AGE_S : 0}`,
    "SameSite=Lax",
    ...(domain ? [`Domain=${domain}`] : []),
    ...(secure ? ["Secure"] : []),
  ].join("; ")
}

export function readWalletPresence(cookies: string, secure: boolean): boolean {
  const name = `${cookieName(secure)}=1`
  return cookies.split(";").some((part) => part.trim() === name)
}
