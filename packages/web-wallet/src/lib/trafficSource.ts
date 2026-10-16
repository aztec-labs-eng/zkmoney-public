/** The acquisition channels `onboarding_started` reports: the campaign's closed taxonomy. */
export const TRAFFIC_SOURCES = ["email", "x-post", "x-ads", "invite", "direct"] as const

export type TrafficSource = (typeof TRAFFIC_SOURCES)[number]

const X_REFERRER_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "t.co"])

function isTagged(value: string | null): value is Exclude<TrafficSource, "direct"> {
  return value !== "direct" && (TRAFFIC_SOURCES as readonly (string | null)[]).includes(value)
}

/**
 * A known utm_source, else an invite link, else an X referrer, else direct. Only the resolved
 * value leaves this function; the URL and the referrer are not kept.
 */
export function trafficSource(url: string, referrer: string): TrafficSource {
  let params: URLSearchParams
  try {
    params = new URL(url).searchParams
  } catch {
    params = new URLSearchParams()
  }
  const utm = params.get("utm_source")
  if (isTagged(utm)) return utm
  if (params.has("invite")) return "invite"
  try {
    if (X_REFERRER_HOSTS.has(new URL(referrer).hostname)) return "x-post"
  } catch {
    // An unparseable referrer is no referrer.
  }
  return "direct"
}

let landing: TrafficSource = "direct"

/** Runs once before routing, which can drop the landing URL's query on a redirect. */
export function captureLandingSource(): void {
  landing = trafficSource(window.location.href, document.referrer)
}

export function landingSource(): TrafficSource {
  return landing
}
