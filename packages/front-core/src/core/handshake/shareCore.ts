import type { Address } from "viem"
import type { Network } from "@obsidion/core/constants"
import { encodeInline, type HandshakeInlinePacket } from "./handshakeInlineCodec"
import { buildHandshakeLink } from "./connectLink"
import { normalizeTag } from "../../utils/normalizeTag"

/**
 * Pure generate-side core for the serverless QR / link contact handshake. The platform React hooks
 * wrap this with storage / XMTP / UI state; the build→record
 * flow itself is unit-testable with plain injected collaborators.
 */

/** The connect format version this build mints. Coupled with the chain below. */
export const CONNECT_FORMAT_VERSION = "1.0"

/** Collaborators the pure mint core needs — injected so the flow is testable. */
export interface MintQRHandshakeShareDeps {
  /** The owner's tag, carried in the packet (omitted when absent). */
  tag: string | undefined
  /** The owner's own XMTP handle (Ethereum-format address) — connect-back target. */
  ownXmtpHandle: Address
  /** Chain segment of the packet `version` (e.g. "testnet"). */
  chain: Network
  /** Wallet origin to mint on, e.g. `mintableOrigin(location.origin, network)`. */
  baseUrl: string
  /** Optional own L2 (Aztec) address for direct display / payment. */
  l2Address?: string
  /** Optional own L1 stealth address (web-fallback deposit target). */
  stealthAddress?: Address
  /** Fresh per-share UUID generator. */
  uuid: () => string
  /** Wall clock (epoch ms), injectable for tests. */
  now: () => number
  /** Persist the per-share `uuid` locally for connect-back matching. */
  record: (uuid: string) => Promise<void>
}

/**
 * Mint one fresh handshake packet and return its QR payload. Pure orchestration
 * over injected collaborators — no React, no module-level singletons, no
 * network.
 *
 * Ordering is load-bearing: we `encodeInline` FIRST (a malformed packet throws
 * here) and only `record` the local entry on success, so a failed mint leaves
 * no dangling local record.
 */
export async function mintQRHandshakeShare(deps: MintQRHandshakeShareDeps): Promise<string> {
  const uuid = deps.uuid()
  const packet: HandshakeInlinePacket = {
    version: `${CONNECT_FORMAT_VERSION}:${deps.chain}`,
    kind: "handshake",
    xmtpHandle: deps.ownXmtpHandle,
    uuid,
    time: deps.now(),
  }
  if (deps.l2Address) packet.l2Address = deps.l2Address
  if (deps.stealthAddress) packet.stealthAddress = deps.stealthAddress
  // `encodeInline` validates the tag against the registry charset and throws on anything else.
  if (deps.tag) packet.tag = normalizeTag(deps.tag) ?? deps.tag

  const encoded = encodeInline(packet)
  // Record only AFTER a successful encode — a malformed packet throws above and
  // never reaches here, so there is no orphaned local record.
  await deps.record(uuid)

  return buildHandshakeLink(deps.baseUrl, encoded)
}
