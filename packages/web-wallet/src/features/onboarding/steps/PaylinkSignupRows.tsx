import { ConfirmationSheetDetailRow } from "@obsidion/web-ds"
import type { PaylinkSignupQuote } from "../../paylink/paylinkSignupQuote"
import { DEPOSIT_TERMS_PENDING, formatTokenAmount } from "./DepositTermsRows"

/**
 * Where a paylink-funded signup's money goes: what the user keeps now and after the sweep, the tag
 * price (waived when the signed fee is the sweep fee), L1 processing (sweep fee, both portal cuts,
 * relayer tip) and the prover tip. Every figure waits for its own read rather than showing one
 * that would move once a cut or the sweep fee lands.
 */
export function PaylinkSignupRows({
  quote,
  tokenSymbol,
  tokenDecimals,
}: {
  quote?: PaylinkSignupQuote
  tokenSymbol: string
  tokenDecimals: number
}) {
  const amount = (v: bigint | undefined) =>
    v === undefined ? DEPOSIT_TERMS_PENDING : formatTokenAmount(v, tokenDecimals, tokenSymbol)
  const row = (id: string, label: string, value: React.ReactNode) => (
    <ConfirmationSheetDetailRow
      label={label}
      value={<span data-testid={`paylink-signup-${id}`}>{value}</span>}
    />
  )
  return (
    <div className="ww-deposit-terms">
      {(quote === undefined || quote.youReceive !== undefined) &&
        row("you-receive", "You'll receive", <strong>{amount(quote?.youReceive)}</strong>)}
      {quote?.paylink !== undefined && row("paylink", "Paylink", amount(quote.paylink))}
      {row(
        "tag-price",
        "Tag price",
        quote?.tagWaived === undefined ? (
          DEPOSIT_TERMS_PENDING
        ) : quote.tagWaived ? (
          <span style={{ color: "var(--accent-green)" }}>Waived</span>
        ) : (
          amount(quote.tagFee)
        ),
      )}
      {row("network-fee", "Network fee", amount(quote?.networkFee))}
      {row("proving-fee", "Proving fee", amount(quote?.provingFee))}
      {row("returned", "Returned after registration", amount(quote?.returned))}
    </div>
  )
}
