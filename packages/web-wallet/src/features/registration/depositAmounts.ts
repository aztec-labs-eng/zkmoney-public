import { toCents, usdFromCents } from "../../ui/format"

/** A required amount, as money: rounded up to the cent, so sending what it says always covers it. */
export function formatDepositDue(amount: bigint, decimals: number): string {
  return usdFromCents(toCents(amount, decimals, true))
}

/** An amount already at the address: rounded down to the cent, never more than is there. */
export function formatDepositSeen(amount: bigint, decimals: number): string {
  return usdFromCents(toCents(amount, decimals, false))
}
