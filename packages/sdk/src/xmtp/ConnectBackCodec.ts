/**
 * Custom XMTP content type carrying a redeemed QR / link handshake UUID
 * back to the sharer (the "connect-back").
 *
 * Emitted by the scanner of a handshake after they resolve the sharer's
 * encrypted blob and add the sharer as a contact. The sharer matches the
 * `uuid` against their local issued-blob store, auto-adds the scanner, and
 * deletes the blob (single-use). The payload carries the redeemed UUID and,
 * when the scanner has one, their claimed tag. The authenticated sender is
 * recovered from the XMTP conversation; the tag is accepted only after a
 * registry forward-resolve whose XMTP binding matches that sender.
 *
 * Payload encoding: UTF-8 JSON.
 */

import { ContentTypeId } from "@xmtp/content-type-primitives"
import type { ContentCodec, EncodedContent } from "@xmtp/content-type-primitives"

import { ConnectBackContentSchema, CodecDecodeError, type ConnectBackContent } from "./types.js"

/**
 * Content type identifier for handshake connect-backs.
 * Rendered as `"obsidion.xyz/connect-back:1.0"` by the XMTP SDK.
 */
export const ConnectBackContentTypeId = new ContentTypeId({
  authorityId: "obsidion.xyz",
  typeId: "connect-back",
  versionMajor: 1,
  versionMinor: 0,
})

/**
 * Codec for `ConnectBackContent`. Implements XMTP's `ContentCodec`
 * interface so it can be registered with `Client.create({ codecs: [...] })`
 * in any XMTP SDK (browser / node).
 */
export class ConnectBackCodec implements ContentCodec<ConnectBackContent> {
  readonly contentType = ConnectBackContentTypeId

  encode(content: ConnectBackContent): EncodedContent {
    // Validate on encode so a malformed payload surfaces at send time, not on
    // the recipient after network delivery.
    const parsed = ConnectBackContentSchema.parse(content)
    const json = JSON.stringify(parsed)
    const bytes = new TextEncoder().encode(json)
    return {
      type: this.contentType,
      parameters: {},
      content: bytes,
      fallback: this.fallback(parsed),
    }
  }

  decode(encoded: EncodedContent): ConnectBackContent {
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

    const result = ConnectBackContentSchema.safeParse(parsedJson)
    if (!result.success) {
      throw new CodecDecodeError(
        `Payload did not match ConnectBackContent schema: ${result.error.message}`,
        result.error,
      )
    }
    return result.data
  }

  /**
   * Human-readable text shown by any XMTP client that doesn't have this codec
   * registered. Must be non-empty per XMTP convention. Kept deliberately
   * generic — no UUID, no sender identity — to avoid leaking the handshake
   * token to non-Obsidion clients.
   */
  fallback(_content: ConnectBackContent): string {
    return "Connected on zk.money"
  }

  /** Trigger push delivery at notification-server level when push is wired up. */
  shouldPush = (_content: ConnectBackContent): boolean => true
}
