import { LIMITS_DOCS_URL } from "../../lib/links"

/**
 * The flows whose batches spend the account's registered allowance, by the context their failures
 * are reported under. The voucher and registration-broadcast rails refuse with the same
 * "allowance exhausted", but their one-use allowance is not the account's and never renews.
 */
const REGISTERED_RAIL_CONTEXTS = new Set([
  "contact:send",
  "paylink:create",
  "withdraw:submit",
  "deposit:resolve",
  "request-link:create",
])

/**
 * Copy for a batch the ClaimFPC could not sponsor: the account's registered allowance had no use left
 * (registered rails only), the FPC itself was out of fee juice, or network fees were above the price
 * it sponsors at (any flow). All are refused before the transaction lands, so nothing was sent.
 * Undefined for any other failure.
 */
export function sponsorshipErrorCopy(
  error: unknown,
  context: string,
): { title: string; message: string; link?: { label: string; href: string } } | undefined {
  for (let cause = error, depth = 0; cause != null && depth < 5; depth++) {
    const text = cause instanceof Error ? cause.message : String(cause)
    if (/insufficient fee payer balance/i.test(text)) {
      return {
        title: "Sponsored transactions paused",
        message:
          "This transaction was not sent. Please try again later.",
      }
    }
    // `_assert_fee_within_max` in claim_fpc/src/main.nr.
    if (/gas settings exceed whitelist max_fee/i.test(text)) {
      return {
        title: "Network fees are too high",
        message:
          "This transaction was not sent. Aztec network fees are too high for transactions to go " +
          "through. Your funds are safe, and full functionality will be available when network fees " +
          "stabilize.",
        link: { label: "How sponsored fees work", href: LIMITS_DOCS_URL },
      }
    }
    if (REGISTERED_RAIL_CONTEXTS.has(context) && /allowance exhausted/i.test(text)) {
      return {
        title: "No sponsored transactions left",
        message:
          "This transaction was not sent: the account has no sponsored transactions left right " +
          "now. Settings > Sponsored transactions shows how the allowance renews.",
      }
    }
    cause = cause instanceof Error ? cause.cause : undefined
  }
  return undefined
}
