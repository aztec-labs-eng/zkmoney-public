/** What the bridge-in sheet shows of its quote, from its flow's state. */
import type { BridgeInQuote } from "@obsidion/front-core"
import { addDollars, bridgeCharged, bridgeDollarFee, bridgeFeeUsd } from "./bridgeChains"
import type { BridgeInState } from "./BridgeInModal/bridgeInTransition"

/** The answer shown for `key`, if the sheet holds one for it. */
export const selectQuote = (s: BridgeInState, key: string | undefined) =>
  key !== undefined && s.quote?.key === key ? s.quote : undefined

/**
 * A quote's fees in dollars, decimal. A dollar coin's bridge fee is its whole loss to what lands,
 * else the provider's price; the whole fee adds the deposit fee, once known.
 */
export function bridgeInFees(
  quote: BridgeInQuote,
  {
    fixed,
    dollars,
    inDecimals,
    outDecimals,
    depositFee,
  }: {
    fixed: boolean
    /** The origin coin is a dollar coin. */
    dollars: boolean
    inDecimals: number
    outDecimals: number
    depositFee?: string
  },
): { bridge?: string; whole?: string } {
  const bridge = dollars
    ? bridgeDollarFee(quote, bridgeCharged(quote, fixed), inDecimals, outDecimals)
    : bridgeFeeUsd(quote, outDecimals)
  const whole =
    bridge !== undefined && depositFee !== undefined ? addDollars(bridge, depositFee) : undefined
  return { bridge, whole }
}
