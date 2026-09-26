// Canonical sdk tests must pass with no network. Loopback stays open for tests that start a local
// server; any other host fails here instead of passing by reaching a live node.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"])
const realFetch = globalThis.fetch

const isLoopback = (url: string) => {
  try {
    return LOOPBACK.has(new URL(url).hostname)
  } catch {
    return true
  }
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!isLoopback(url)) {
    return Promise.reject(new Error(`canonical sdk tests must not reach the network: ${url}`))
  }
  return realFetch(input, init)
}) as typeof fetch
