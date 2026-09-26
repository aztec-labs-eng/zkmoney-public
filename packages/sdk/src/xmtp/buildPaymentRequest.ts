/**
 * Builders for the `AztecPaymentRequestContent` payloads — one per lifecycle
 * kind (announce / declined). Fulfillment has no payload: it rides the on-chain
 * `Transfer.meta`.
 *
 * Pure functions — no side effects, no I/O — so they can be unit-tested in Node
 * without a running XMTP client. The validated content is handed to the XMTP
 * codec (`AztecPaymentRequestCodec.encode`) by the caller, which performs a
 * second Zod validation on encode.
 */

import { AztecPaymentRequestContentSchema, type AztecPaymentRequestContent } from "./types.js"

export interface BuildPaymentRequestArgs {
  /** Join key minted by the requester (`0x`-hex field); echoed back on decline, rides `Transfer.meta` on fulfillment. */
  requestId: string
  /** Requester's Aztec tag (normalized, e.g. `"alice"`) — the payee. */
  requesterTag: string
  /**
   * Amount in the token's smallest units as a string (or bigint, coerced to
   * string). `0` means "any amount". Stringified to avoid JSON precision loss.
   */
  amountAtomic: string | bigint
  /** The token's on-chain address (hex) and UI metadata. */
  token: {
    address: string
    symbol?: string
    decimals: number
  }
  /** Aztec network the request targets. */
  networkId: string
  /** Optional short note, ≤500 chars per the content-type schema. */
  note?: string
  /** Optional soft expiry (epoch ms). */
  expiresAt?: number
}

/** Build the `request` announcement payload and validate it against the schema. */
export function buildPaymentRequest(args: BuildPaymentRequestArgs): AztecPaymentRequestContent {
  const amountStr =
    typeof args.amountAtomic === "bigint" ? args.amountAtomic.toString() : args.amountAtomic

  const draft: Record<string, unknown> = {
    kind: "request",
    requestId: args.requestId,
    requesterTag: args.requesterTag,
    amountAtomic: amountStr,
    token: normalizeHex(args.token.address),
    decimals: args.token.decimals,
    networkId: args.networkId,
  }
  // Only include optional fields when meaningful — an absent note should be
  // absent, not an empty string.
  if (args.token.symbol) draft.tokenSymbol = args.token.symbol
  if (args.note) draft.note = args.note
  if (args.expiresAt !== undefined) draft.expiresAt = args.expiresAt

  return AztecPaymentRequestContentSchema.parse(draft)
}

export interface BuildPaymentRequestDeclinedArgs {
  requestId: string
  networkId: string
}

/** Build the `request-declined` signal payload. */
export function buildPaymentRequestDeclined(
  args: BuildPaymentRequestDeclinedArgs,
): AztecPaymentRequestContent {
  return AztecPaymentRequestContentSchema.parse({
    kind: "request-declined",
    requestId: args.requestId,
    networkId: args.networkId,
  })
}

function normalizeHex(input: string): string {
  const lower = input.toLowerCase()
  return lower.startsWith("0x") ? lower : `0x${lower}`
}
