import * as actual from "../../../src/features/onboarding/useDepositWatch"
import { fixtureState } from "./control"
export const useDepositWatch: typeof actual.useDepositWatch = (config, watch) => {
  const active = fixtureState()
  const observed = actual.useDepositWatch(config, active ? null : watch)
  if (!active || !watch) return observed
  return new URLSearchParams(location.search).get("registrationFixture") === "short"
    ? { ...observed, balance: 2n * 10n ** 18n, token: watch.token }
    : { ...observed, balance: 0n, token: undefined }
}
