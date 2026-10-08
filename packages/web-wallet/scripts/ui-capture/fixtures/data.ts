import { parseUnits } from "viem"
import { encodeRequestInline, type RequestInlinePacket } from "@obsidion/front-core"
import { demoClaimFragments, DEMO_L2_ADDRESS } from "../../../src/dev/demoFixtures"

export const field = (byte: string) => `0x${byte.repeat(32)}`
export const TOKEN = field("1b")
export const ROLLUP = "0x00000000000000000000000000000000000000cafe"
export const SIPA = "0x1111111111111111111111111111111111111111" as const
/** The pool's next address, once `SIPA` may still receive an unresolved send. */
export const SIPA_NEXT = "0x2222222222222222222222222222222222222222" as const
export const TX_HASH = field("0a")
export const TOKEN_INFO = { address: TOKEN, name: "DAI", symbol: "DAI", decimals: 18 }

export function requestPacket(kind = "request"): RequestInlinePacket {
  return {
    requestId: field("0c"), requesterTag: "ada", requesterAddress: DEMO_L2_ADDRESS,
    amountAtomic: kind === "request-any" ? 0n : parseUnits(kind === "request-small" ? "0.5" : "24", 18),
    tokenSymbol: "DAI", tokenDecimals: 18,
    tokenAddress: kind === "request-token" ? field("1c") : TOKEN,
    networkId: kind === "request-network" ? "0x00000000000000000000000000000000000000beef" : ROLLUP,
    expiresAt: Date.now() + (kind === "request-expired" ? -60_000 : 86_400_000),
    sipaAddress: SIPA,
    note: "Dinner and groceries for the weekend, including the train tickets home.",
  }
}

export function entryPath(kind: string): string {
  if (kind === "visitor" || kind === "visitor-email") {
    const fragments = demoClaimFragments()
    return `/link#${kind === "visitor-email" ? fragments.email : fragments.direct}`
  }
  // Frozen v1 vector built with the codec test map; the current encoder intentionally writes only v3.
  if (kind === "request-legacy") return "/request#2QEDpQEBAmpyZXEtbGVnYWN5A2NhZGEEUAAAAAAAAAAAAAAAAAFuNgAIeCwweDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwY2FmZQ"
  if (kind === "request-invalid") return "/request#unreadable-capture-packet"
  const kinds = ["request", "request-small", "request-any", "request-expired", "request-network", "request-token", "request-legacy"]
  if (!kinds.includes(kind)) throw new Error(`Unknown flow entry: ${kind}`)
  return `/request#${encodeRequestInline(requestPacket(kind))}`
}
