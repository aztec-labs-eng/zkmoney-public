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
 * (registered rails only), or the FPC itself was out of fee juice (any flow). Both are refused before
 * the transaction lands, so nothing was sent. Undefined for any other failure.
 */
export function sponsorshipErrorCopy(
  error: unknown,
  context: string,
): { title: string; message: string } | undefined {
  for (let cause = error, depth = 0; cause != null && depth < 5; depth++) {
    const text = cause instanceof Error ? cause.message : String(cause)
    if (/insufficient fee payer balance/i.test(text)) {
      return {
        title: "Sponsored transactions paused",
        message:
          "This transaction was not sent. Please try again later.",
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
