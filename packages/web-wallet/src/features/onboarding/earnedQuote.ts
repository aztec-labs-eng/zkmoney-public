import { floorExceedsAsk, termsUnpriced } from "./registrationAsk"

export const EARNED_QUOTE_ERROR =
  "Your earned tag price has not been confirmed yet. Wait a few minutes, then try again."

/**
 * A campaign hint may refuse a paid quote; it can never authorize a discount. The signature is the
 * authority. Throws `EARNED_QUOTE_ERROR` for a quote that is not the earned one.
 */
export function assertEarnedQuote(
  terms: { reduced?: boolean; fee: string; minDeposit: string } | undefined,
): void {
  if (terms?.reduced !== true || termsUnpriced(terms)) throw new Error(EARNED_QUOTE_ERROR)
  if (floorExceedsAsk({ min: BigInt(terms.minDeposit), fee: BigInt(terms.fee) }, "earned_tag")) {
    throw new Error(EARNED_QUOTE_ERROR)
  }
}
