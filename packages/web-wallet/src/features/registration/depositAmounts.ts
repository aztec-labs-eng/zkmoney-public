import { formatUnits } from "viem"
import { usdBalance } from "../../ui/format"

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
