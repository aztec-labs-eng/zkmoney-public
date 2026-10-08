import { ConfirmationSheetDetailRow } from "@obsidion/web-ds"
import type { PaylinkSignupQuote } from "../../paylink/paylinkSignupQuote"
import { DEPOSIT_TERMS_PENDING, formatTokenAmount } from "./DepositTermsRows"

/**
 * Where a paylink-funded signup's funds go: what the user keeps now, the tag price (waived when the
 * signed fee is the sweep fee), one network fee (sweep fee, both portal cuts, the relayer tip, the
 * committed prover tip, the dust the sweep returns), and a signed minimum's excess the sweep
 * returns after registration, so the rows sum to what leaves the balance. Every figure waits for
 * its own read rather than showing one that would move once a cut or the sweep fee lands.
 */
export function PaylinkSignupRows({
  quote,
  tokenSymbol,
  tokenDecimals,
  speed,
}: {
  quote?: PaylinkSignupQuote
  tokenSymbol: string
  tokenDecimals: number
  /** The speed choice, on a surface that offers one. */
  speed?: React.ReactNode
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
      {speed}
      {row(
        "network-fee",
        "Network fee",
        amount(quote === undefined ? undefined : quote.networkFee + quote.provingFee),
      )}
      {quote !== undefined &&
        quote.returned > 0n &&
        row("returned", "Returned after registration", amount(quote.returned))}
    </div>
  )
}
