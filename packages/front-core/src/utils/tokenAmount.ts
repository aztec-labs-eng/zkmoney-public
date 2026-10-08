/**
 * `0.03163` / `1,234.5` — a token display amount trimmed to at most `maxDecimals` places, with
 * trailing zeros dropped, for a line too short for full precision. An amount too small to show at
 * all renders as a `<` bound rather than rounding away to zero.
 */
export function tokenAmount(display: string, maxDecimals = 5): string {
  const n = Number(display)
  if (!Number.isFinite(n)) return display
  const smallest = 10 ** -maxDecimals
  if (n > 0 && n < smallest) return `<${smallest.toFixed(maxDecimals)}`
  return n.toLocaleString("en-US", { maximumFractionDigits: maxDecimals })
}
