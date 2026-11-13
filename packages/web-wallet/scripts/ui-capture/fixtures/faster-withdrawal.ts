import * as actual from "../../../src/features/withdraw/useFasterWithdrawal"
import { fixtureState } from "./control"
import { CAPTURE_OFFER as OFFER } from "./faster-offer"
export * from "../../../src/features/withdraw/useFasterWithdrawal"
export const useFasterWithdrawal: typeof actual.useFasterWithdrawal = (opts) => {
  const fixture = fixtureState() !== null
  const live = actual.useFasterWithdrawal(fixture ? { ...opts, active: false } : opts)
  return fixture && opts.active ? { offer: OFFER, current: true, loading: false } : live
}
