import type { BridgeInRecord } from "./types"

/** What a bridge-in that ended short returns, in base units. */
export interface BridgeInReturned {
  symbol: string
  amount: bigint
  decimals: number
  /** A token other than the coin sent: the one the bridge carried after an origin swap or wrap. */
  other: boolean
}

/**
 * The amount a bridge-in that ended short names: what Across refunds, the bridged token where the
 * origin coin was swapped or wrapped, else the origin coin.
 */
export function bridgeInReturned(
  record: Pick<BridgeInRecord, "status" | "symbol" | "inputAmount" | "inputDecimals" | "bridged">,
): BridgeInReturned {
  const refund = record.status === "refunded" || record.status === "expired"
  const bridged = refund ? record.bridged : undefined
  return bridged
    ? {
        symbol: bridged.symbol,
        amount: BigInt(bridged.amount),
        decimals: bridged.decimals,
        other: true,
      }
    : {
        symbol: record.symbol,
        amount: BigInt(record.inputAmount),
        decimals: record.inputDecimals,
        other: false,
      }
}
