import * as actual from "../../../src/features/onboarding/nameAvailability"
import { fixtureState } from "./control"
export * from "../../../src/features/onboarding/nameAvailability"

const STATUSES = ["available", "reserved", "blocked", "blocked-reserved", "unknown"] as const

/** `?nameFixture=<status>` answers the open availability probe; without it the probe is unknown. */
export const probeNameAvailability: typeof actual.probeNameAvailability = async (...args) => {
  if (!fixtureState()) return actual.probeNameAvailability(...args)
  const status = new URLSearchParams(location.search).get("nameFixture") ?? "unknown"
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
    throw new Error(`Unknown name fixture: ${status}`)
  }
  return { status: status as actual.NameAvailability, grantValid: false, grantBound: false }
}
