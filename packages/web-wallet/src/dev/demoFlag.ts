/**
 * Dev-only demo mode: `?demo=<scenario>` seeds fixture data so the whole UI can be viewed and
 * navigated with no Aztec node, no L1 chain and no passkey. Everything heavy lives in the rest of
 * `src/dev/`, reached only through a dynamic import in `walletBoot.tsx`; this module is a leaf so the
 * handful of production gates can import it without pulling fixtures into the bundle.
 *
 * `import.meta.env.DEV` is a build-time literal, so a production build compiles every branch
 * guarded here to `false` and drops the demo chunk entirely.
 */

import scenarios from "./demoScenarios.json"

export type DemoScenario = keyof typeof scenarios
export const DEMO_SCENARIOS = /* @__PURE__ */ Object.keys(scenarios) as DemoScenario[]

/** What a bare `?demo` picks. */
export const DEMO_DEFAULT_SCENARIO: DemoScenario = "recovery"

const SESSION_KEY = "webwallet.demo"

/**
 * The scenario is latched on first read and mirrored into sessionStorage: in-app navigation drops
 * the query string, so re-parsing per render would switch demo mode off under the user's feet.
 * `?demo=off` clears the latch.
 */
let latched: DemoScenario | null | undefined

function isScenario(value: string | null): value is DemoScenario {
  return DEMO_SCENARIOS.includes(value as DemoScenario)
}

function session(): Storage | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

function resolve(): DemoScenario | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null
  const param = new URLSearchParams(window.location.search).get("demo")
  if (param === "off") {
    session()?.removeItem(SESSION_KEY)
    return null
  }
  const requested =
    param === "" ? DEMO_DEFAULT_SCENARIO : param ?? session()?.getItem(SESSION_KEY) ?? null
  if (requested !== null && !isScenario(requested)) {
    console.warn(
      `[demo] unknown scenario "${requested}" — expected ${DEMO_SCENARIOS.join(" | ")}; ` +
        "booting the real app instead",
    )
    return null
  }
  if (requested) session()?.setItem(SESSION_KEY, requested)
  return requested
}

export function demoScenario(): DemoScenario | null {
  if (latched === undefined) latched = resolve()
  return latched
}

export function isDemoMode(): boolean {
  return demoScenario() !== null
}

/** Seeding refusal seam: this origin holds a real wallet — boot the real app instead. */
export function disableDemoMode(): void {
  latched = null
  session()?.removeItem(SESSION_KEY)
}

/** Test seam — drops the latch so a suite can exercise more than one URL. */
export function resetDemoFlagForTests(): void {
  latched = undefined
}
