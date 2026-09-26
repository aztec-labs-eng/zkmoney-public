import { parseUnits } from "viem"

/**
 * Parse a user-entered amount string into escrow base units.
 *
 * Accepts a comma decimal separator: decimal-pad locales type "5,25", and an
 * amount field may validate a comma-normalized copy but forward the raw
 * string, so it lands here as a comma. `parseUnits` keeps full precision at
 * 18 dp where `parseFloat(amount) * 10 ** decimals` drops significant digits
 * past ~1e16. `human` is the same normalized value for display metadata.
 */
export function parseEscrowAmount(
  amount: string,
  decimals: number,
): { atomic: bigint; human: number } {
  const normalized = amount.replace(/,/g, ".")
  const atomic = parseUnits(normalized, decimals)
  const human = parseFloat(normalized)
  // A positive amount that rounds to zero base units would escrow nothing — and
  // atomic 0 doubles as the "any amount" sentinel for request links, so a fixed
  // request could silently become pay-any-amount. Fail closed instead.
  if (human > 0 && atomic === 0n) {
    throw new Error(`amount ${normalized} is below the smallest unit at ${decimals} decimals`)
  }
  return { atomic, human }
}
