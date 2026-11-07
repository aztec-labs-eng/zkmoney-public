import * as actual from "../../../src/features/sipa/useDepositWatch"
import { fixtureState } from "./control"

export * from "../../../src/features/sipa/useDepositWatch"
export const useDepositWatch: typeof actual.useDepositWatch = (address) => {
  const active = fixtureState()
  const observed = actual.useDepositWatch(active ? null : address)
  if (!active || !address) return observed
  return new URLSearchParams(location.search).get("registrationFixture") === "short"
    ? {
        ...observed,
        balance: 2n * 10n ** 18n,
        token: observed.record?.tokenAddress as `0x${string}` | undefined,
      }
    : { ...observed, balance: 0n, token: undefined }
}
export const useSipaRecord = actual.useSipaRecord
