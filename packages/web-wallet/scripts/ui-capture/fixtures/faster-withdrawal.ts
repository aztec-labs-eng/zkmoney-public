import * as actual from "../../../src/features/withdraw/useFasterWithdrawal"
import { fixtureState } from "./control"
export * from "../../../src/features/withdraw/useFasterWithdrawal"
const OFFER: actual.FasterWithdrawal = {
  proverTip: 42n * 10n ** 16n,
  standardEtaSeconds: 44 * 60,
  tippedEtaSeconds: 12 * 60,
  worstSpeedupSeconds: 30 * 60,
}
export const useFasterWithdrawal: typeof actual.useFasterWithdrawal = (opts) => {
  const fixture = fixtureState() !== null
  const live = actual.useFasterWithdrawal(fixture ? { ...opts, active: false } : opts)
  return fixture && opts.active ? { offer: OFFER, loading: false } : live
}
