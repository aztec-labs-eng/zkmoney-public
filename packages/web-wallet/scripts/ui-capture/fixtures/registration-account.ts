import * as actual from "../../../src/features/onboarding/oxideOnboarding"
import { fixtureState, pause } from "./control"
export * from "../../../src/features/onboarding/oxideOnboarding"

export const reusePasskeyAccount: typeof actual.reusePasskeyAccount = async (...args) => {
  if (!fixtureState()) return actual.reusePasskeyAccount(...args)
  await pause(1500)
  const state = new URLSearchParams(location.search).get("registrationFixture")
  if (state === "passkey-mismatch") throw new actual.PasskeyMismatchError()
  throw new DOMException("Capture passkey is unavailable", "NotAllowedError")
}
export const getClaimStatus: typeof actual.getClaimStatus = async (...args) => {
  if (!fixtureState()) return actual.getClaimStatus(...args)
  await pause()
  return "reserved"
}
