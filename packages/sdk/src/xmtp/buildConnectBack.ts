/**
 * Builder for the `ConnectBackContent` payload sent by the scanner's app
 * immediately after they resolve a handshake connect and add the sharer.
 *
 * Pure function — no side effects, no I/O — so it can be unit-tested in
 * Node without a running XMTP client. The validated content is handed to the
 * XMTP codec (`ConnectBackCodec.encode`) by the caller, which performs a
 * second Zod validation on encode.
 */

import {
  CONNECT_BACK_TAG_MAX_LEN,
  CONNECT_BACK_TAG_REGEX,
  ConnectBackContentSchema,
  type ConnectBackContent,
} from "./types.js"

/** Current connect-back wire schema version. */
export const CONNECT_BACK_VERSION = 1

export interface BuildConnectBackArgs {
  /** Opaque redeemed handshake UUID, matched against the sharer's local store. */
  uuid: string

  /**
   * Wire schema version. Defaults to {@link CONNECT_BACK_VERSION}; callers
   * normally omit this and let the builder stamp the current version.
   */
  version?: number

  /**
   * Scanner's own tag, when they have one. Lowercased and stripped of a
   * leading `@` before validation; omitted when absent or empty after that.
   */
  tag?: string
}

function normalizeClaimedTag(tag: string): string {
  let next = tag.trim().toLowerCase()
  if (next.startsWith("@")) next = next.slice(1)
  return next
}

/**
 * Build the connect-back payload and validate it against the schema.
 *
 * Throws if the inputs violate the schema (e.g. empty / oversized uuid).
 * Callers should treat a throw here as a bug to fix at the call site, not a
 * runtime error to retry.
 */
export function buildConnectBack(args: BuildConnectBackArgs): ConnectBackContent {
  const tag = args.tag ? normalizeClaimedTag(args.tag) : ""
  const draft: { version: number; uuid: string; tag?: string } = {
    version: args.version ?? CONNECT_BACK_VERSION,
    uuid: args.uuid,
  }
  if (tag && tag.length <= CONNECT_BACK_TAG_MAX_LEN && CONNECT_BACK_TAG_REGEX.test(tag)) {
    draft.tag = tag
  }

  return ConnectBackContentSchema.parse(draft)
}
