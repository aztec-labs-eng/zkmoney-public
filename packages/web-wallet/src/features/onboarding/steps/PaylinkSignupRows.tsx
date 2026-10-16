import { formatUnits } from "viem"
import { ConfirmationSheetDetailRow } from "@obsidion/web-ds"
import type { PaylinkSignupQuote } from "../../paylink/paylinkSignupQuote"
import { DEPOSIT_TERMS_PENDING } from "./DepositTermsRows"

/** `0.50 DAI`: at least cents, and every digit a fee carries beyond them. */
function centsAmount(amount: bigint, decimals: number, symbol: string): string {
  const [whole, fraction = ""] = formatUnits(amount, decimals).split(".")
  return `${whole}.${fraction.padEnd(2, "0")} ${symbol}`
}

/**
 * Where a paylink-funded signup's funds go: the tag price (free when the signed fee is the sweep
 * fee), one network fee (sweep fee, both portal cuts, the relayer tip, the committed prover tip,
 * the dust the sweep returns), a signed minimum's excess the sweep returns after registration, and
 * what the user keeps now, so the rows sum to the payment. Every figure waits for its own read
 * rather than showing one that would move once a cut or the sweep fee lands.
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
    v === undefined ? DEPOSIT_TERMS_PENDING : centsAmount(v, tokenDecimals, tokenSymbol)
  const row = (id: string, label: string, value: React.ReactNode) => (
    <ConfirmationSheetDetailRow
      label={label}
      value={<span data-testid={`paylink-signup-${id}`}>{value}</span>}
    />
  )
  return (
    <div className="ww-deposit-terms">
      {row(
        "tag-price",
        "Name price",
        quote?.tagWaived === undefined ? (
          DEPOSIT_TERMS_PENDING
        ) : quote.tagWaived ? (
          <span style={{ color: "var(--accent-green)" }}>Free with ticket</span>
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
      {(quote === undefined || quote.youReceive !== undefined) &&
        row("balance-after", "Your balance after", <strong>{amount(quote?.youReceive)}</strong>)}
    </div>
  )
}
