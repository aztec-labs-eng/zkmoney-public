/** The published per-operation limit as the wallet types and shows it, so tests follow the policy. */
import { PUBLIC_TX_LIMIT_USD } from "@obsidion/core/constants"

export const LIMIT = PUBLIC_TX_LIMIT_USD

/** `5,000` / `4,999.75`; `cents` pads to `5,000.00`. */
export const grouped = (n: number, cents = false) =>
  n.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 })

/** `$5,000` */
export const LIMIT_USD = `$${grouped(LIMIT)}`

/** `4999.5`: an amount as typed into a field. */
export const typed = (n: number) => String(Number(n.toFixed(2)))
