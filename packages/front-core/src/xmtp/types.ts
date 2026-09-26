/**
 * Public type surface for the XMTP transfer broadcaster.
 *
 * Lives in `@obsidion/front-core` so that the orchestration logic — "given
 * a recipient `xmtpAddress` and a successful `sendToken` result, build the
 * codec content and ship it through an XMTP sender" — can be unit-tested
 * without an XMTP or PXE runtime. Each platform supplies its own
 * `IXmtpSender` implementation.
 */

import type { AztecPaymentRequestContent } from "@obsidion/sdk"

/**
 * Minimal interface the broadcaster needs from an XMTP transport.
 * Implementations should:
 *   - Resolve `canMessage` against the underlying XMTP network and return
 *     a lower-cased-address-keyed `Record<string, boolean>`.
 *   - Throw if the underlying client is not initialized or if the network
 *     call fails. The broadcaster catches and maps to a `failed` status —
 *     it never lets a throw escape.
 */
export interface IXmtpSender {
  canMessage(addresses: string[]): Promise<Record<string, boolean>>
  /**
   * Send a payment-request lifecycle message (announce / declined). Resolves to the XMTP message
   * id, throws if the client isn't ready or the network call fails.
   */
  sendRequest(peerAddress: string, content: AztecPaymentRequestContent): Promise<string>
}

// ── Inbox client port ───────────────────────────────────────────────────────
//
// Platform-neutral surface the inbox driver (`inboxDriver.ts`) consumes from an
// XMTP client. Web supplies a browser-sdk adapter that normalizes at the boundary.

/**
 * Conversation handle as seen by the inbox driver. Opaque beyond these fields —
 * the driver only reads them and passes the handle back into the client port.
 */
export interface InboxConversation {
  id: string
  /** Stream messages carry a topic; the driver maps topic -> id via this. */
  topic?: string
  /** "allowed" | "unknown" | "denied". Missing / throwing is treated as unknown. */
  consentState?(): Promise<string>
}

/**
 * Decoded message DTO. `sentNs` may be a number or bigint (the browser SDK
 * exposes ns timestamps as bigint); the driver's cursor math is bigint-safe
 * either way.
 */
export interface InboxMessage {
  id: string
  sentNs: number | bigint
  contentTypeId: string
  content(): unknown
  topic?: string
}

/**
 * Client surface the inbox driver depends on.
 */
export interface XmtpClientManagerLike {
  isReady(): boolean
  readonly installationId: string | null
  listConversations(): Promise<InboxConversation[]>
  /** Network-sync the conversation, then return messages newer than `sentNs`. */
  messagesAfter(
    conversation: InboxConversation,
    sentNs: number | bigint,
    limit?: number,
  ): Promise<InboxMessage[]>
  /** Like `messagesAfter` but reads the local DB without a per-conversation sync. */
  messagesAfterLocal(
    conversation: InboxConversation,
    sentNs: number | bigint,
    limit?: number,
  ): Promise<InboxMessage[]>
  /** Network-sync only allowed+unknown conversations that have unread messages. */
  syncAllConversations(): Promise<{ numEligible: number; numSynced: number }>
  /** Resolve a conversation id (the cursor-map key) to a live handle, or undefined. */
  findConversation(id: string): Promise<InboxConversation | undefined>
  /** Subscribe to all incoming messages (allowed+unknown); returns a cancel handle. */
  subscribeAllMessages(
    onMessage: (message: InboxMessage) => void,
    onClose?: () => void,
  ): Promise<() => void>
  /**
   * Every Ethereum-format address associated with the authenticated DM peer's inbox; empty when
   * the peer isn't resolvable. Receivers accept a claimed tag when the tag's bootstrap address
   * is among them.
   */
  getDmPeerAddresses(conversation: InboxConversation): Promise<string[]>
}

/** Why the broadcaster declined to call the adapter at all. */
export type BroadcastSkipReason =
  /** Caller did not resolve an XMTP address for the recipient. */
  | "no-xmtp-address"
  /** Adapter's `canMessage` returned `false` for the recipient. */
  | "recipient-not-reachable"

/**
 * Result of a `broadcast` call. The broadcaster never throws — every error
 * surface flows through `failed`. `"client-not-ready"` is intentionally
 * not a skip reason: it surfaces as `failed`, so callers can distinguish
 * "we couldn't check reachability" from "we checked and got `false`".
 */
export type BroadcastStatus =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: BroadcastSkipReason }
  | { status: "failed"; reason: string; cause?: unknown }
