/**
 * Custom XMTP content type carrying the payment-request lifecycle — a request
 * announcement and its fulfilled / declined signals.
 *
 * A payment request is the inverse of a paylink (a pull, not a push): the
 * requester asks to be paid and the payer fulfills with an ordinary L2 send.
 * The `requestId` join key threads a fulfillment/decline back to its request
 * across devices. The authenticated sender is recovered from the XMTP
 * conversation on the receiving side; the payload carries no identity beyond
 * the requester's public tag.
 *
 * Payload encoding: UTF-8 JSON (mirrors `ConnectBackCodec`).
 */

import { ContentTypeId } from "@xmtp/content-type-primitives"
import type {
  ContentCodec,
  EncodedContent,
} from "@xmtp/content-type-primitives"

import {
  AztecPaymentRequestContentSchema,
  CodecDecodeError,
  type AztecPaymentRequestContent,
} from "./types.js"

/**
 * Content type identifier for payment requests.
 * Rendered as `"obsidion.xyz/payment-request:1.0"` by the XMTP SDK.
 */
export const AztecPaymentRequestContentTypeId = new ContentTypeId({
  authorityId: "obsidion.xyz",
  typeId: "payment-request",
  versionMajor: 1,
  versionMinor: 0,
})

/**
 * Codec for `AztecPaymentRequestContent`. Implements XMTP's `ContentCodec`
 * interface so it can be registered with `Client.create({ codecs: [...] })`
 * in any XMTP SDK (browser / node).
 */
export class AztecPaymentRequestCodec implements ContentCodec<AztecPaymentRequestContent> {
  readonly contentType = AztecPaymentRequestContentTypeId

  encode(content: AztecPaymentRequestContent): EncodedContent {
    // Validate on encode so a malformed payload surfaces at send time, not on
    // the recipient after network delivery.
    const parsed = AztecPaymentRequestContentSchema.parse(content)
    const json = JSON.stringify(parsed)
    const bytes = new TextEncoder().encode(json)
    return {
      type: this.contentType,
      parameters: {},
      content: bytes,
      fallback: this.fallback(parsed),
    }
  }

  decode(encoded: EncodedContent): AztecPaymentRequestContent {
    let rawText: string
    try {
      rawText = new TextDecoder().decode(encoded.content)
    } catch (cause) {
      throw new CodecDecodeError("Failed to decode UTF-8 payload bytes", cause)
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(rawText)
    } catch (cause) {
      throw new CodecDecodeError("Failed to parse payload as JSON", cause)
    }

    const result = AztecPaymentRequestContentSchema.safeParse(parsedJson)
    if (!result.success) {
      throw new CodecDecodeError(
        `Payload did not match AztecPaymentRequestContent schema: ${result.error.message}`,
        result.error,
      )
    }
    return result.data
  }

  /**
   * Human-readable text shown by any XMTP client that doesn't have this codec
   * registered. Must be non-empty per XMTP convention. Kept deliberately
   * generic and per-kind — no amount, no identity — to avoid leaking request
   * details to non-Obsidion clients (the ConnectBack precedent).
   */
  fallback(content: AztecPaymentRequestContent): string {
    switch (content.kind) {
      case "request-declined":
        return "Request declined"
      default:
        return "Payment request"
    }
  }

  /** Trigger push delivery at notification-server level when push is wired up. */
  shouldPush = (_content: AztecPaymentRequestContent): boolean => true
}
