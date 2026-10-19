/**
 * The config profile, requested as the page starts instead of once the wallet chunk has loaded and
 * run: the first screen waits on it. The boot's first request for it takes this one.
 */
let early: { url: string; controller: AbortController; response: Promise<Response> } | undefined

/** Not on a desktop build, whose launcher may point the boot at another profile. */
export function prefetchProfile(env: Record<string, string | undefined> = import.meta.env): void {
  const url = env.VITE_CONFIG_PROFILE_URL
  if (!url || env.VITE_DESKTOP_BUILD === "true" || early) return
  const controller = new AbortController()
  // As the profile client asks for it.
  const response = fetch(url, {
    headers: { accept: "application/json" },
    signal: controller.signal,
  })
  response.catch(() => {})
  early = { url, controller, response }
}

/** `fetch`, whose first request for the prefetched profile takes the prefetch and its abort. */
export const profileFetch: typeof fetch = (input, init) => {
  const taken = early
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!taken || url !== taken.url) return fetch(input, init)
  early = undefined
  const signal = init?.signal
  if (signal?.aborted) taken.controller.abort(signal.reason)
  else
    signal?.addEventListener("abort", () => taken.controller.abort(signal.reason), { once: true })
  return taken.response
}

export function __resetProfilePrefetchForTests(): void {
  early = undefined
}
