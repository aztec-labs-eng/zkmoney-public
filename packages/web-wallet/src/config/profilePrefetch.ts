/**
 * Requests the config profile as the page starts instead of once the wallet chunk has loaded and
 * run: the first screen waits on it. Not on a desktop build, whose launcher may point the boot at
 * another profile. Returns the `fetch` whose first request for the profile takes this one, and its
 * abort.
 */
export function prefetchProfile(
  env: Record<string, string | undefined> = import.meta.env,
): typeof fetch | undefined {
  const url = env.VITE_CONFIG_PROFILE_URL
  if (!url || env.VITE_DESKTOP_BUILD === "true") return undefined
  const controller = new AbortController()
  // As the profile client asks for it.
  const response = fetch(url, {
    headers: { accept: "application/json" },
    signal: controller.signal,
  })
  response.catch(() => {})
  let taken = false
  return (input, init) => {
    const asked = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (taken || asked !== url) return fetch(input, init)
    taken = true
    const signal = init?.signal
    if (signal?.aborted) controller.abort(signal.reason)
    else signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
    return response
  }
}
