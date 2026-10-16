import { formatUnits } from "viem"
import {
  REGISTRATION_ASK_DEPOSIT_TOTAL,
  REGISTRATION_SCHEDULE_DEFAULTS,
} from "@obsidion/core/constants"

/** The default registration prices, so tests follow a price change instead of restating it. */
export const PAID = REGISTRATION_SCHEDULE_DEFAULTS.standard
export const RANDOM = REGISTRATION_SCHEDULE_DEFAULTS.earned_tag
export const PAID_ASK = REGISTRATION_ASK_DEPOSIT_TOTAL.standard
export const RANDOM_ASK = REGISTRATION_ASK_DEPOSIT_TOTAL.earned_tag

/** `$4.25`: how the wallet's copy prints an 18-dp DAI amount. */
export const usd = (amount: bigint) => `$${Number(formatUnits(amount, 18)).toFixed(2)}`
