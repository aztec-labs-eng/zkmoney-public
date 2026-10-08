"use strict"

const PROBE_TIMEOUT_MS = 5_000

// One retry absorbs a cold network interface or a momentary hiccup at app start.
async function withRetry(attempt) {
  try {
    return await attempt()
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    return attempt()
  }
}

// Mirrors the wallet's own verdict on the config profile, so the launcher routes
// to the settings page exactly when the wallet would refuse to boot:
//   "ok"          — the wallet boots from the live document
//   "unreachable" — no answer, 5xx, or a cut-off body; the wallet boots from the
//                   baked copy on its own (fatal only when the build baked none)
//   "rejected"    — the server answered with a 4xx, an expired document, or
//                   something that is not a profile; fatal, and only the
//                   shipped-configuration setting gets past it
// Identity, network and schema checks stay with the wallet: a document that
// fails them is a build problem, not an outage.
async function probeConfigProfile(url, { fetchImpl = fetch, now = () => new Date() } = {}) {
  let response
  let signal
  try {
    response = await withRetry(() => {
      signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
      return fetchImpl(url, { headers: { accept: "application/json" }, signal })
    })
  } catch (error) {
    return { state: "unreachable", detail: error.message }
  }
  if (response.status >= 400 && response.status <= 499) {
    return { state: "rejected", detail: `the server answered ${response.status}` }
  }
  if (!response.ok) {
    return { state: "unreachable", detail: `the server answered ${response.status}` }
  }
  let document
  try {
    document = await response.json()
  } catch (error) {
    // Mirrors the wallet: only a complete body that is not JSON is a verdict on the document. A
    // read cut short by the deadline or the network is silence, and the wallet falls back on it.
    if (signal?.aborted || !(error instanceof SyntaxError)) {
      return { state: "unreachable", detail: `the response was cut short: ${error.message}` }
    }
    return { state: "rejected", detail: `the document is not JSON: ${error.message}` }
  }
  if (!document || typeof document !== "object" || typeof document.profileId !== "string") {
    return { state: "rejected", detail: "the document is not a configuration profile" }
  }
  if (typeof document.expiresAt === "string" && Date.parse(document.expiresAt) <= now().getTime()) {
    return { state: "rejected", detail: `the document expired at ${document.expiresAt}` }
  }
  return { state: "ok", detail: null }
}

module.exports = { probeConfigProfile }
