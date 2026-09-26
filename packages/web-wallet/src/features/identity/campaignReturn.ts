import { getConfig } from "../../config/env"

/**
 * Where the wallet sends someone on their way out. The campaign keeps its own session in a cookie
 * only that origin can clear, so the URL names the sign-out it has to perform on arrival: landing
 * there still signed in is what makes leaving the wallet look like it did not work. Empty when no
 * campaign is configured (a local pair, a self-hosted wallet, the e2e), leaving the caller its own
 * route.
 */
export function campaignSignedOutUrl(): string {
  const base = getConfig().campaignUrl.replace(/\/$/, "")
  return base ? `${base}/?signedout=1` : ""
}
