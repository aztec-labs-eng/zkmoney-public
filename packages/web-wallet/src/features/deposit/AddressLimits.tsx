import { formatUnits } from "viem"
import { InfoButton } from "../limits/InfoButton"
import { LimitsRows } from "../limits/AboutLimitsContent"
import { LimitLine } from "../limits/publicLimit"

/** Shown where a route cannot establish a maximum. */
export const MAX_SEND_UNAVAILABLE = "Unavailable"

/** `2,500 DAI`: exact, with the integer part grouped. */
export function tokenAmountLabel(atomic: bigint, decimals: number, symbol: string): string {
  const [whole, fraction] = formatUnits(atomic, decimals).split(".")
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${fraction ? `${grouped}.${fraction}` : grouped} ${symbol}`
}

/**
 * The limit for an address or QR payment. It stays on screen, apart from any dismissible warning, so a
 * payer sees it every time the address is shown. `onInfo` opens the details.
 */
export function AddressLimits({ onInfo }: { onInfo?: () => void }) {
  return (
    <LimitLine
      kind="address"
      testId="address-limits"
      info={onInfo && <InfoButton label="About the deposit limit" onClick={onInfo} />}
    />
  )
}

/** The route's maximum send and what it credits, for the About limits details. */
export function AddressLimitsDetail({
  symbol,
  decimals,
  maxSendAtomic,
  maxCreditAtomic,
  checking = false,
  swapInto,
}: {
  /** The token the payer sends. */
  symbol: string
  decimals: number
  /** Undefined when the route cannot establish it. */
  maxSendAtomic?: bigint
  /** What arrives at the maximum send, in `symbol`; undefined when the route cannot state it. */
  maxCreditAtomic?: bigint
  /** An input to the maximum is still being read. */
  checking?: boolean
  /** The settlement token that `symbol` is swapped into before crediting. */
  swapInto?: string
}) {
  const label = (atomic: bigint | undefined) =>
    checking
      ? "Checking…"
      : atomic === undefined
      ? MAX_SEND_UNAVAILABLE
      : tokenAmountLabel(atomic, decimals, symbol)
  return (
    <>
      <LimitsRows
        rows={[
          {
            label: "Maximum send amount",
            value: label(maxSendAtomic),
            testId: "address-limits-max-send",
          },
          {
            label: "Maximum received",
            value: label(maxCreditAtomic),
            testId: "address-limits-max-credit",
          },
        ]}
      />
      {swapInto && (
        <p className="ww-about-limits__note">
          {symbol} is swapped to {swapInto} at the market rate, so the {swapInto} credited can
          differ.
        </p>
      )}
    </>
  )
}
