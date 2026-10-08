import * as actual from "../../../src/features/allowance/readAllowance"
import type { ClaimFpcAllowance } from "@obsidion/sdk"
import { fixtureState } from "./control"
import { field } from "./data"

const STATES = [
  "available",
  "not-subscribed",
  "renewal-unknown",
  "spent",
  "unavailable",
  "retry",
] as const
type AllowanceState = (typeof STATES)[number]
const DAY = 86_400
const RETRY_CONTROLS = '[data-testid="about-limits-sponsorship-retry"]'
// `retry` fails until the user activates a retry control: dev StrictMode remounts start extra reads,
// so a read count cannot tell a retry from a remount.
let retried = false
document.addEventListener(
  "click",
  (event) => {
    if ((event.target as Element | null)?.closest?.(RETRY_CONTROLS)) retried = true
  },
  true,
)

/** `?allowanceFixture=<state>`; without it the read stays pending, as it did before this fixture. */
function allowanceState(): AllowanceState | null {
  const value = new URLSearchParams(location.search).get("allowanceFixture")
  if (value === null) return null
  if (!STATES.includes(value as AllowanceState))
    throw new Error(`Unknown allowance fixture: ${value}`)
  return value as AllowanceState
}

/** The rail's existing reads: `has_subscription`, `get_subscription_uses` and `get_config`. */
function allowanceFor(state: Exclude<AllowanceState, "unavailable" | "retry">): ClaimFpcAllowance {
  const read = (subscribed: boolean, uses: number, refillPeriod: number): ClaimFpcAllowance => ({
    subscribed,
    uses,
    maxTx: 100,
    refillPeriod,
  })
  switch (state) {
    case "available":
      return read(true, 42, DAY)
    case "not-subscribed":
      return read(false, 0, DAY)
    case "renewal-unknown":
      return read(true, 0, DAY)
    case "spent":
      return read(true, 0, 0)
  }
}

export const readSponsoredAllowance: typeof actual.readSponsoredAllowance = async (deps) => {
  if (!fixtureState()) return actual.readSponsoredAllowance(deps)
  const state = allowanceState()
  if (!state) return new Promise(() => {})
  if (state === "unavailable" || (state === "retry" && !retried)) {
    throw new Error("Capture allowance read is unavailable")
  }
  return {
    fpcAddress: field("fc"),
    railId: 1,
    allowance: allowanceFor(state === "retry" ? "available" : state),
  }
}
