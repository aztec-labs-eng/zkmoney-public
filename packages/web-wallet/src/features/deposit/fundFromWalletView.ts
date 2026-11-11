/** What the send-from-wallet sheet shows, from its flow's state. */
import type { L1TokenBalance } from "./l1DepositTokenBalance"
import type { FundState } from "./DepositFromWalletModal/fundFromWalletTransition"

/** The review's fee moved since it was entered; a fee first read on the review is no change. */
export const selectFeeChanged = (s: FundState, fee: string | undefined): boolean =>
  s.phase !== "form" &&
  (s.review.changed || (fee != null && s.review.fee !== undefined && fee !== s.review.fee))

/** The balance a rejected transfer reported, until a later read supersedes it. */
export const selectShortfall = (s: FundState, read: L1TokenBalance | undefined) =>
  s.shortfall && s.shortfall.over === read ? s.shortfall.balance : undefined
