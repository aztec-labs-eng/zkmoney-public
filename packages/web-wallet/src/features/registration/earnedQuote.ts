import { WalletError } from "@obsidion/core/errors"
import { floorExceedsAsk, termsUnpriced } from "./registrationAsk"

/**
 * A campaign hint may refuse a paid quote; it can never authorize a discount. The signature is the
 * authority. Throws `registration.earnedUnconfirmed` for a quote that is not the earned one.
 */
export function assertEarnedQuote(
  terms: { reduced?: boolean; fee: string; minDeposit: string } | undefined,
): void {
  if (
    terms?.reduced !== true ||
    termsUnpriced(terms) ||
    floorExceedsAsk({ min: BigInt(terms.minDeposit), fee: BigInt(terms.fee) }, "earned_tag")
  )
    throw new WalletError("registration.earnedUnconfirmed")
}
