/** Pure view logic for the Receive flow. Kept UI-free so vitest covers it. */
import { decimalInput, parseAmount } from "../../ui/format"

/** Dollar amount for a request: strictly positive and finite, optional leading "$". */
export function parseRequestAmount(input: string): number | null {
  const raw = input.trim().replace(/^\$/, "")
  if (!raw) return null
  const n = parseAmount(decimalInput(raw))
  return Number.isFinite(n) && n > 0 ? n : null
}
