// HTML entry.
//
// zone.js has to monkey-patch Promise, setTimeout and fetch before any other module evaluates, and
// static ESM imports hoist above executable code — so `main.tsx` (the app's real entry) is reached
// through a dynamic import that only runs once the patching is done. Any build without
// VITE_PROFILER folds the comparison to a literal false and drops the zone.js load out of the
// bundle — which is why the flag is spelled inline rather than imported (src/profiling/README.md).
async function boot() {
  console.info(`[boot] commit ${__BUILD_COMMIT__}`)
  if (import.meta.env.VITE_PROFILER === "true") {
    await import("zone.js")
    const Zone = (globalThis as typeof globalThis & { Zone?: { current: { name: string } } }).Zone
    console.info(
      "[profiler] zone.js loaded:",
      Zone?.current ? `ok (root zone: ${Zone.current.name})` : "FAILED",
    )
  }
  await import("./main")
}

void boot()
