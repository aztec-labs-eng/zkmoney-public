/**
 * The launch campaign's origin, from the URL a build bakes. It is the one sender the bridge page
 * trusts, so only https qualifies (plus http://localhost for a local pair): a plain-http or opaque
 * URL, whose origin is the shared literal "null", is refused before anything is built.
 */

type CampaignEnv = { VITE_CAMPAIGN_URL?: string }

export function campaignOriginFrom(url: string | undefined): string {
  if (!url) return ""
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`VITE_CAMPAIGN_URL is not a URL: ${url}`)
  }
  const local = parsed.protocol === "http:" && parsed.hostname === "localhost"
  if (parsed.protocol !== "https:" && !local) {
    throw new Error(
      `VITE_CAMPAIGN_URL must be https (http://localhost for a local pair), got ${url}`,
    )
  }
  return parsed.origin
}

/** The campaign URL, for a build config. `VITE_ADMISSION_GATE` is accepted and arms nothing. */
export function assertCampaignEnv(env: CampaignEnv): void {
  campaignOriginFrom(env.VITE_CAMPAIGN_URL)
}
