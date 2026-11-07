import * as actual from "../../../src/features/onboarding/oxideOnboarding"
import { fixtureState, pause } from "./control"
export * from "../../../src/features/onboarding/oxideOnboarding"

export const getClaimStatus: typeof actual.getClaimStatus = async (...args) => {
  if (!fixtureState()) return actual.getClaimStatus(...args)
  await pause()
  return "reserved"
}
