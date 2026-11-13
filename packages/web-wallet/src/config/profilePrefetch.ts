import { featuresUrlOf } from "@obsidion/config-client/features-url"

/**
 * Requests the config profile and its features document as the page starts instead of once the
 * wallet chunk has loaded and run: the first screen waits on both. Not on a desktop build, whose
 * launcher may point the boot at another profile. Returns the `fetch` whose first request for each
 * takes its prefetched response, and its abort.
 */
export function prefetchProfile(
  env: Record<string, string | undefined> = import.meta.env,
): typeof fetch | undefined {
  const url = env.VITE_CONFIG_PROFILE_URL
  if (!url || env.VITE_DESKTOP_BUILD === "true") return undefined
  const prefetched = new Map<string, { response: Promise<Response>; controller: AbortController }>()
  for (const target of [url, featuresUrlOf(url)]) {
    if (!target) continue
    const controller = new AbortController()
    // As the config client asks for it.
    const response = fetch(target, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
    response.catch(() => {})
    prefetched.set(target, { response, controller })
  }
  return (input, init) => {
    const asked = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const held = prefetched.get(asked)
    if (!held) return fetch(input, init)
    prefetched.delete(asked)
    const signal = init?.signal
    if (signal?.aborted) held.controller.abort(signal.reason)
    else
      signal?.addEventListener("abort", () => held.controller.abort(signal.reason), { once: true })
    return held.response
  }
}
