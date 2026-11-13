import type { FasterWithdrawal } from "../../../src/features/withdraw/useFasterWithdrawal"

/** The faster option every capture offers: a 0.42 DAI tip that saves half an hour. */
export const CAPTURE_OFFER: FasterWithdrawal = {
  proverTip: 42n * 10n ** 16n,
  standardEtaSeconds: 44 * 60,
  tippedEtaSeconds: 12 * 60,
  worstSpeedupSeconds: 30 * 60,
  measured: true,
}
