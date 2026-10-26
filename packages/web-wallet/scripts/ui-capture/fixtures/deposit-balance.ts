import * as actual from "../../../src/features/deposit/l1DepositTokenBalance"
import { fixtureState } from "./control"
export * from "../../../src/features/deposit/l1DepositTokenBalance"
export const readL1DepositTokenBalance: typeof actual.readL1DepositTokenBalance = async (
  ...args
) => {
  if (!fixtureState()) return actual.readL1DepositTokenBalance(...args)
  return { raw: 1000n * 10n ** 18n, value: 1000, display: "1000 DAI", symbol: "DAI", decimals: 18 }
}
