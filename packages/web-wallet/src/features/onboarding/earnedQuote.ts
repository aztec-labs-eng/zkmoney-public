import { floorExceedsAsk, termsUnpriced } from "./registrationAsk"

export const EARNED_QUOTE_ERROR =
  "Your earned tag price has not been confirmed yet. Return to the campaign to sync your eligibility, then try again."

/** Shown when the portal's cut is unread, so the earned price could not be checked. A retry settles it. */
export const EARNED_QUOTE_UNCONFIRMED_ERROR =
  "Your earned tag price could not be confirmed. Try again."

/**
 * A campaign hint may refuse a paid quote; it can never authorize a discount. The signature is the
 * authority. Throws `EARNED_QUOTE_ERROR` for a quote that is not the earned one, and
 * `EARNED_QUOTE_UNCONFIRMED_ERROR` where `fpcFundingCut` is undefined and nothing can be checked.
 */
export function assertEarnedQuote(
  terms: { reduced?: boolean; fee: string; minDeposit: string } | undefined,
  fpcFundingCut: bigint | undefined,
): void {
  if (terms?.reduced !== true || termsUnpriced(terms)) throw new Error(EARNED_QUOTE_ERROR)
  const exceeds = floorExceedsAsk(
    { min: BigInt(terms.minDeposit), fee: BigInt(terms.fee) },
    "earned_tag",
    fpcFundingCut,
  )
  if (exceeds === undefined) throw new Error(EARNED_QUOTE_UNCONFIRMED_ERROR)
  if (exceeds) throw new Error(EARNED_QUOTE_ERROR)
}
