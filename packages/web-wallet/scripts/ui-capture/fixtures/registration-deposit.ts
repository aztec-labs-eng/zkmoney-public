import * as actual from "../../../src/features/onboarding/useDepositWatch"
import { fixtureState } from "./control"
export const useDepositWatch: typeof actual.useDepositWatch = (config, watch) => {
  const active = fixtureState()
  const balance = actual.useDepositWatch(config, active ? null : watch)
  if (!active || !watch) return balance
  return new URLSearchParams(location.search).get("registrationFixture") === "short" ? 2n * 10n ** 18n : 0n
}
