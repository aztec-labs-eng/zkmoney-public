/**
 * Pure validation for a decoded request-link packet. `networkId` compares
 * against the ROLLUP ADDRESS the encoder stamps — not the `aztec-<network>`
 * label used for XMTP signals. Legacy v1/v2 packets carry no tokenAddress:
 * the with-account flow tolerates that (the send uses the wallet's own token),
 * the accountless surface must reject it (token pairing is unverifiable).
 */
import { formatUnits } from "viem"
import type { RequestInlinePacket } from "@obsidion/front-core"

export type RequestLinkProblem = "expired" | "wrongNetwork" | "wrongToken" | "legacyUnverifiable"

export function validateRequestPacket(
  packet: RequestInlinePacket,
  env: { rollupAddress: string; l2Token: string; requireTokenAddress: boolean },
  now: number = Date.now(),
): RequestLinkProblem | null {
  if (packet.expiresAt && now > packet.expiresAt) return "expired"
  if (packet.networkId !== env.rollupAddress) return "wrongNetwork"
  if (packet.tokenAddress) {
    if (packet.tokenAddress.toLowerCase() !== env.l2Token.toLowerCase()) return "wrongToken"
  } else if (env.requireTokenAddress) {
    return "legacyUnverifiable"
  }
  return null
}

/** Human amount string; "" for an any-amount link. */
export function requestAmountDisplay(packet: RequestInlinePacket): string {
  if (packet.amountAtomic <= 0n) return ""
  return formatUnits(packet.amountAtomic, packet.tokenDecimals ?? 6)
}
