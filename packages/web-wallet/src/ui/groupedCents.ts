/**
 * `2,499.65` / `2,500` / `<0.01`: a decimal display string to the cent, grouped. A charge that rounds to nothing
 * still charges, so it never reads as zero. Undefined for a display that is not a number.
 */
export function groupedCents(display: string): string | undefined {
  const n = Number(display)
  if (!Number.isFinite(n)) return undefined
  if (n > 0 && n < 0.005) return "<0.01"
  const grouped = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return grouped.replace(/\.00$/, "")
}
