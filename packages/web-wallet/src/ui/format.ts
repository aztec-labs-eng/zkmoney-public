import { formatUnits, getAddress, isAddress, parseUnits } from "viem"
import { groupedCents } from "./groupedCents"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
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

/**
 * An L1 address checksummed and split where MetaMask splits it: the first 7 characters (with `0x`)
 * and the last 5, so an address reads the same in both. A value too short to split is all `head`.
 */
export function l1AddressParts(address: string): { head: string; middle: string; tail: string } {
  const value = isAddress(address, { strict: false }) ? getAddress(address) : address
  if (value.length <= 12) return { head: value, middle: "", tail: "" }
  return { head: value.slice(0, 7), middle: value.slice(7, -5), tail: value.slice(-5) }
}

/** `0xAbCdE…12345`: an L1 address cut like MetaMask cuts it. */
export function shortL1Addr(address: string): string {
  const { head, middle, tail } = l1AddressParts(address)
  return middle ? `${head}…${tail}` : head
}

export { normalizeAmountInput as decimalInput, tokenAmount } from "@obsidion/front-core"

/**
 * Field message for typed amount text the wallet will not accept; nothing while the field is empty.
 * A field read with `parseUnits` passes its token's `decimals`: it takes that precision and never
 * goes through a JS number, so it skips the number check.
 */
export function amountError(text: string, decimals?: number): string | undefined {
  if (!text) return undefined
  if (!isDecimalAmount(text)) return "Enter a number"
  const places = decimals ?? AMOUNT_MAX_DECIMALS
  if (decimalPlaces(text) > places) return `Use up to ${places} decimal places`
  if (decimals === undefined && !isSafeAmountNumber(text)) return "Amount is too large"
  return undefined
}

/** Typed amount as a number, or NaN when `amountError` would show (`2-`, `1e3`, `1.111`, spaces). */
export function parseAmount(text: string): number {
  return text && !amountError(text) ? Number(text) : NaN
}

/** MAX-button text: the balance floored to cents, so it passes `amountError` and can never overspend. */
export function floorToCents(atomic: bigint, decimals: number): string {
  return floorTo(atomic, decimals, AMOUNT_MAX_DECIMALS)
}

/** The balance floored to `places` decimals. */
export function floorTo(atomic: bigint, decimals: number, places: number): string {
  return formatUnits(floorAtomic(atomic, decimals, places), decimals)
}

/** `floorTo` in base units. */
export function floorAtomic(atomic: bigint, decimals: number, places: number): bigint {
  if (places >= decimals) return atomic
  return atomic - (atomic % 10n ** BigInt(decimals - places))
}

/** Wallet-side amount: what the user wants to land plus the fee, decimal-safe. */
export function chargedAmount(amount: string, fee: string, decimals: number): string | undefined {
  try {
    return formatUnits(parseUnits(amount.trim(), decimals) + parseUnits(fee, decimals), decimals)
  } catch {
    return undefined
  }
}

/** `1234.57`: a balance rounded half up to cents, ungrouped; `0.00` for none. */
export function fixedCents(balance: { atomic: bigint; decimals: number } | null): string {
  if (!balance) return "0.00"
  const shift = balance.decimals - 2
  const cents =
    shift >= 0
      ? (balance.atomic + 10n ** BigInt(shift) / 2n) / 10n ** BigInt(shift)
      : balance.atomic * 10n ** BigInt(-shift)
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`
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

/** `0.25 USDC` / `1,200 DAI`: a token amount by {@link groupedCents}. */
export function tokenFigure(display: string, symbol: string): string {
  return `${groupedCents(display) ?? display} ${symbol}`
}

export function tokenAtomicFloor(atomic: bigint, symbol: string, decimals = DEFAULT_DECIMALS) {
  const floored = floorToCents(atomic, decimals)
  return atomic > 0n && Number(floored) === 0 ? `<0.01 ${symbol}` : tokenFigure(floored, symbol)
}

/** `$1,234.56` from base units. */
export function usdAtomic(atomic: bigint, decimals: number = DEFAULT_DECIMALS): string {
  return usdBalance(formatUnits(atomic, decimals))
}

/** What a balance shows while the user hides balances. */
export const HIDDEN_BALANCE = "$••••••"

/**
 * `$1,234.56` from base units with the cents truncated, as the ticking Savings balance shows them;
 * every Savings dollar figure uses it so none disagrees with the balance by a cent.
 */
export function usdAtomicFloor(atomic: bigint, decimals: number = DEFAULT_DECIMALS): string {
  const cents = (atomic < 0n ? -atomic : atomic) / 10n ** BigInt(decimals - 2)
  const sign = atomic < 0n && cents > 0n ? "-" : ""
  return `${sign}$${(cents / 100n).toLocaleString("en-US")}.${String(cents % 100n).padStart(
    2,
    "0",
  )}`
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

/** `Just now` / `5m ago` / `2h ago` / `Yesterday` / `3d ago`; older rows read as a date. */
export function relativeTimeLabel(ms: number, now = Date.now()): string {
  const minutes = Math.floor((now - ms) / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return "Yesterday"
  return days < 7 ? `${days}d ago` : formatDateLabel(ms)
}
