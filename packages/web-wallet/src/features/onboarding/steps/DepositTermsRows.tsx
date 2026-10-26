import type { ReactNode } from "react"
import { formatUnits } from "viem"
import type { RegistrationKind } from "@obsidion/core/types"
import { ConfirmationSheetDetailRow } from "@obsidion/web-ds"
import type { DepositTokens } from "../../deposit/loadDepositFacts"
import { usdBalance } from "../../../ui/format"
import { LimitLine } from "../../limits/publicLimit"

/** Amount in the token's display units, trimmed. */
export function formatTokenAmount(amount: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(amount, decimals)} ${symbol}`
}

/**
 * What a registration costs, as money. The rail's token is a dollar stablecoin, so a price is a
 * price — naming the token where an amount belongs asks the reader to convert, and says nothing
 * about what they may fund with. The asset appears once, beside the address, as what to send.
 */
export function formatDepositAmount(amount: bigint, decimals: number): string {
  return usdBalance(formatUnits(amount, decimals))
}

/** Whole cents, rounded up or down in the token's integer arithmetic. */
function cents(amount: bigint, decimals: number, up: boolean): bigint {
  if (decimals <= 2) return amount * 10n ** BigInt(2 - decimals)
  const step = 10n ** BigInt(decimals - 2)
  const whole = amount / step
  return up && amount % step !== 0n ? whole + 1n : whole
}

/** A required amount, as money: rounded up to the cent, so sending what it says always covers it. */
export function formatDepositDue(amount: bigint, decimals: number): string {
  return usdBalance(formatUnits(cents(amount, decimals, true), 2))
}

/** An amount already at the address: rounded down to the cent, never more than is there. */
export function formatDepositSeen(amount: bigint, decimals: number): string {
  return usdBalance(formatUnits(cents(amount, decimals, false), 2))
}

/**
 * What a registration may be funded with: the fee token, then the tokens the sweep swaps into it. A safety
 * line rather than a price, since anything else sent to the address strands there. Empty until the table is read.
 */
export function fundingAssetsLabel(tokens: DepositTokens | undefined): string {
  return listLabel(tokens?.offered.map((token) => token.symbol) ?? []) ?? ""
}

/** The tokens a registration may be funded with that are swapped into the fee token first. */
export function swapAssetsLabel(tokens: DepositTokens | undefined): string | undefined {
  return listLabel(tokens?.offered.filter((t) => t.swapped).map((token) => token.symbol) ?? [])
}

function listLabel(symbols: string[]): string | undefined {
  if (symbols.length < 2) return symbols[0]
  return `${symbols.slice(0, -1).join(", ")} or ${symbols[symbols.length - 1]}`
}

/** Stands in for a figure whose inputs are still being read. */
export const DEPOSIT_TERMS_PENDING = "Checking…"

export interface DepositTerms {
  /** The deposit to send. Unknown while the schedule it is quoted on is still being settled. */
  total?: bigint
  /** The schedule fee owed out of the total: the tag price on a standard schedule, the relayer's
   *  sweep fee alone on a free one. Unknown until the schedule is read. */
  fee?: bigint
  /** The relayer's sweep fee, paid out of the schedule fee. Unknown until the deployment is read. */
  sweepFee?: bigint
  tokenSymbol: string
  tokenDecimals: number
  /** The schedule this registration is quoted on. */
  kind: RegistrationKind
  /** No schedule is being read for this registration: the rows it prices are left out rather than
   *  held open for a figure that is not coming. The total and the waiver stand on their own. */
  scheduleUnavailable?: boolean
  /** Tokens swapped into the settlement token before crediting, e.g. "USDC or USDT". */
  swapAssets?: string
}

/** What the total covers; each part is unknown until its inputs are read. */
export function depositTermsSplit({ total, fee, sweepFee }: DepositTerms): {
  price?: bigint
  funding?: bigint
  opening?: bigint
} {
  return {
    // The tag price is what the fee carries above the sweep.
    price:
      fee === undefined || sweepFee === undefined
        ? undefined
        : fee > sweepFee
        ? fee - sweepFee
        : 0n,
    // The relayer's sweep fee funds the network on every schedule.
    funding: sweepFee,
    opening: fee === undefined || total === undefined ? undefined : total > fee ? total - fee : 0n,
  }
}

/** Every figure carries its own test id, so a check reads the figure, not the sentence around it. */
function TermsRow({ id, label, value }: { id: string; label: string; value: ReactNode }) {
  return (
    <ConfirmationSheetDetailRow
      label={label}
      value={<span data-testid={`deposit-terms-${id}`}>{value}</span>}
    />
  )
}

/** The per-deposit limit. `info` opens its details, which name the valuation it is checked with. */
export function DepositLimitRows({ info }: { info?: ReactNode }) {
  return <LimitLine kind="address" testId="deposit-terms-maximum" info={info} />
}

/**
 * What the deposit buys: the total, ruled off from the split it covers. Every derived row waits for
 * its own input rather than showing a figure that would move once a read lands, and the split
 * drops out altogether when no schedule is being read for it.
 */
export function DepositTermsRows({
  networkLabel,
  limitInfo,
  ...terms
}: DepositTerms & {
  /** The chain the deposit is sent on, e.g. "Ethereum (ERC20)". */
  networkLabel?: string
  /** Opens the limit's details. */
  limitInfo?: ReactNode
}) {
  const { total, tokenDecimals, kind, scheduleUnavailable, tokenSymbol, swapAssets } = terms
  const amount = (v: bigint) => formatDepositAmount(v, tokenDecimals)
  const { price, funding, opening } = depositTermsSplit(terms)
  const priced = !scheduleUnavailable
  const free = kind === "earned_tag"
  return (
    <div className="ww-deposit-terms">
      <TermsRow
        id="total"
        label="Total to send"
        value={
          total === undefined ? (
            DEPOSIT_TERMS_PENDING
          ) : (
            <strong>{formatDepositDue(total, tokenDecimals)}</strong>
          )
        }
      />
      {(free || priced) && (
        <TermsRow
          id="tag-price"
          label="Tag price"
          value={
            free ? (
              <span style={{ color: "var(--accent-green)" }}>Waived</span>
            ) : price === undefined ? (
              DEPOSIT_TERMS_PENDING
            ) : (
              amount(price)
            )
          }
        />
      )}
      {priced && (
        <TermsRow
          id="network-funding"
          label="Network funding"
          value={funding === undefined ? DEPOSIT_TERMS_PENDING : amount(funding)}
        />
      )}
      {priced && (
        <TermsRow
          id="opening-balance"
          label="Opening balance"
          value={opening === undefined ? DEPOSIT_TERMS_PENDING : amount(opening)}
        />
      )}
      {priced && swapAssets && (
        <p className="ww-limits__note" data-testid="deposit-terms-swap-note">
          The opening balance assumes you send {tokenSymbol}. {swapAssets} is swapped to{" "}
          {tokenSymbol} at the market rate, so the balance can differ.
        </p>
      )}
      {networkLabel && <TermsRow id="network" label="Network" value={networkLabel} />}
      <DepositLimitRows info={limitInfo} />
    </div>
  )
}
