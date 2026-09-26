import { formatUnits } from "viem"
import {
  AMOUNT_MAX_DECIMALS,
  decimalPlaces,
  formatDateLabel,
  formatTimeLabel,
  isDecimalAmount,
  isSafeAmountNumber,
} from "@obsidion/front-core"

/** `0x1234…abcd` — the app-wide middle ellipsis for addresses and hashes. */
export function shortAddr(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`
}

export { normalizeAmountInput as decimalInput } from "@obsidion/front-core"

/** Field message for typed amount text the wallet will not accept; nothing while the field is empty. */
export function amountError(text: string): string | undefined {
  if (!text) return undefined
  if (!isDecimalAmount(text)) return "Enter a number"
  if (decimalPlaces(text) > AMOUNT_MAX_DECIMALS)
    return `Use up to ${AMOUNT_MAX_DECIMALS} decimal places`
  if (!isSafeAmountNumber(text)) return "Amount is too large"
  return undefined
}

/** Typed amount as a number, or NaN when `amountError` would show (`2-`, `1e3`, `1.111`, spaces). */
export function parseAmount(text: string): number {
  return text && !amountError(text) ? Number(text) : NaN
}

/** MAX-button text: the balance floored to cents, so it passes `amountError` and can never overspend. */
export function floorToCents(atomic: bigint, decimals: number): string {
  const step = 10n ** BigInt(decimals - AMOUNT_MAX_DECIMALS)
  return formatUnits(atomic - (atomic % step), decimals)
}

/** `$12.34` — two-decimal dollars for a whole-token (USD-pegged) display amount. */
export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

/** `$115` / `$0.50` / `<$0.01` — dollars from a decimal display string; whole amounts drop the cents. */
export function usdFigure(display: string): string {
  const n = Number(display)
  if (!Number.isFinite(n)) return display
  // A charge that rounds to nothing still charges: never render it as free.
  if (n > 0 && n < 0.005) return "<$0.01"
  return `$${n.toFixed(2)}`.replace(/\.00$/, "")
}

/** `$1,234.56` — a balance string with thousands separators. */
export function usdBalance(balance: string): string {
  const n = Number(balance)
  if (!Number.isFinite(n)) return `$${balance}`
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Request-link face: grouped dollars, or "Any amount" when the row carries no fixed amount. */
export function requestAmountLabel(amount: number): string {
  return amount > 0 ? usdBalance(String(amount)) : "Any amount"
}

/** One timestamp shape for every activity row, over front-core's date/time labels. */
export function rowTimestamp(ms: number): string {
  return `${formatDateLabel(ms)}, ${formatTimeLabel(ms)}`
}

/**
 * `0.03163` / `1,234.5` — a token display amount trimmed to at most `maxDecimals` places, with
 * trailing zeros dropped. Full precision is unreadable in a quote line; an amount too small to
 * show at all renders as a `<` bound rather than rounding away to zero.
 */
export function tokenAmount(display: string, maxDecimals = 5): string {
  const n = Number(display)
  if (!Number.isFinite(n)) return display
  const smallest = 10 ** -maxDecimals
  if (n > 0 && n < smallest) return `<${smallest.toFixed(maxDecimals)}`
  return n.toLocaleString("en-US", { maximumFractionDigits: maxDecimals })
}
