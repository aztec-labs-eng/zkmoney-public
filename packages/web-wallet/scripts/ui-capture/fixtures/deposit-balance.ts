import * as actual from "../../../src/features/deposit/l1DepositTokenBalance"
import { fixtureState } from "./control"
import { SIPA } from "./data"
export * from "../../../src/features/deposit/l1DepositTokenBalance"
export const readL1TokenBalance: typeof actual.readL1TokenBalance = async (...args) => {
  if (fixtureState() && args[1].toLowerCase() === SIPA.toLowerCase()) return 0n
  return actual.readL1TokenBalance(...args)
}
export const readL1DepositTokenBalance: typeof actual.readL1DepositTokenBalance = async (...args) => {
  if (!fixtureState()) return actual.readL1DepositTokenBalance(...args)
  return { raw: 1000n * 10n ** 18n, value: 1000, display: "1000 DAI", symbol: "DAI", decimals: 18 }
}
