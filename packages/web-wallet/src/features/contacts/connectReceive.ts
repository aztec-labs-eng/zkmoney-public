/**
 * /connect receive orchestration: the inbound `/connect#<packet>` fragment is stashed to
 * sessionStorage at the app shell BEFORE any gate redirect can drop it, then replayed post-unlock
 * as a two-phase flow — `previewConnect` decodes and verifies only; the contact write and the
 * connect-back queue happen in `confirmConnect`, after the user's explicit confirmation (AE10).
 * The fragment is the whole identity: the sharer's tag is inside the packet, not the URL.
 */
import {
  ERR_INVALID,
  HANDSHAKE_LINK_HOST,
  buildHandshakeLink,
  commitQRHandshake,
  navigateIdFor,
  previewQRHandshake,
  type Contact,
  type HandshakeInlinePacket,
  type QRHandshakePreview,
} from "@obsidion/front-core"

export const CONNECT_STASH_KEY = "obsidion.pending-connect"

export interface ConnectStash {
  /** Raw `location.hash` (leading `#` included) — the packet fragment. */
  hash: string
}

/** sessionStorage-shaped seam. */
interface StringStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface ConnectLocation {
  pathname: string
  hash: string
}

/** Stash an inbound /connect fragment. Nothing outside the fragment is read — the URL has no identity. */
export function captureConnectStash(loc: ConnectLocation, store: StringStore): boolean {
  if (loc.pathname !== "/connect" || loc.hash.length < 2) return false
  const stash: ConnectStash = { hash: loc.hash }
  store.setItem(CONNECT_STASH_KEY, JSON.stringify(stash))
  return true
}

export function hasConnectStash(store: StringStore = sessionStorage): boolean {
  return store.getItem(CONNECT_STASH_KEY) !== null
}

/** Consume-once read: the stash is deleted before it is returned, so a re-render can't replay it. */
export function takeConnectStash(store: StringStore = sessionStorage): ConnectStash | null {
  const raw = store.getItem(CONNECT_STASH_KEY)
  if (raw === null) return null
  store.removeItem(CONNECT_STASH_KEY)
  try {
    const parsed = JSON.parse(raw) as ConnectStash
    return typeof parsed.hash === "string" && parsed.hash.startsWith("#") ? parsed : null
  } catch {
    return null
  }
}

/**
 * Rebuild the canonical scan payload from the stash so the shared parser re-validates the packet
 * charset exactly as a scanned link is validated. The anchor origin is arbitrary here — the
 * parser reads no identity from the host — so this never has to match the minting origin.
 */
export function stashToPayload(stash: ConnectStash): string {
  return buildHandshakeLink(HANDSHAKE_LINK_HOST, stash.hash.slice(1))
}

/** Browser entry for App: stash, then drop the fragment from the URL (the packet lives in the stash). */
export function stashInboundConnect(): void {
  if (captureConnectStash(window.location, window.sessionStorage)) {
    history.replaceState(null, "", window.location.pathname + window.location.search)
  }
}

/* ------------------------------ preview phase ------------------------------ */

export type ConnectPreview = QRHandshakePreview

export type ConnectPreviewResult =
  | { kind: "confirm"; preview: ConnectPreview }
  | { kind: "self-scan" }
  | { kind: "error"; message: string }

export interface ConnectPreviewDeps {
  decodeInline: (packet: string) => HandshakeInlinePacket
  /** scanCore's registry cross-check contract: record | null (non-discoverable) | throws (transient). */
  verifyTag?: (tag: string) => Promise<{ l2Address?: string; xmtpAddress?: string } | null>
  ownTag?: string
  ownL2Address?: string
}

/**
 * Decode + verify only — front-core's `previewQRHandshake` with the web self-scan predicate (own
 * tag / L2 address) and `not-a-connect` collapsed to an invalid-link error (the web has no
 * bare-tag scan path to fall back to).
 */
export async function previewConnect(
  payload: string,
  deps: ConnectPreviewDeps,
): Promise<ConnectPreviewResult> {
  const result = await previewQRHandshake(payload, {
    decodeInline: deps.decodeInline,
    verifyTag: deps.verifyTag,
    isSelfScan: (packet) => {
      const ownL2 = deps.ownL2Address?.toLowerCase()
      const ownTag = deps.ownTag?.toLowerCase()
      return Boolean(
        (ownL2 && packet.l2Address?.toLowerCase() === ownL2) || (ownTag && packet.tag === ownTag),
      )
    },
  })
  if (result.kind === "not-a-connect") return { kind: "error", message: ERR_INVALID }
  if (result.kind === "preview") return { kind: "confirm", preview: result.preview }
  return result
}

/* ------------------------------ confirm phase ------------------------------ */

export type ConnectConfirmResult =
  | { kind: "added"; contact: Contact; navigateId: string; pending: boolean }
  /** Nothing was added: `contact`, a stored row under another tag, matched the scan. */
  | { kind: "conflict"; contact: Contact }
  | { kind: "error"; message: string }

export interface ConnectConfirmDeps {
  addOrMergeContact: (entry: Contact) => Promise<Contact>
  /** The leader tab's live client. Absent while this tab holds no client: the connect-back is
   *  queued instead and the mount's flusher delivers it once one exists. */
  sendConnectBack?: (
    peerXmtp: string,
    content: { version: number; uuid: string; tag?: string },
  ) => Promise<{ ok: boolean; reason?: string }>
  /** Outbox for a connect-back that could not be sent live; the mount flushes it at leader start. */
  queueConnectBack: (entry: {
    uuid: string
    peerXmtp: string
    content: { version: number; uuid: string; tag?: string }
  }) => Promise<void>
  connectBackVersion: number
  /** Scanner's own tag, stamped onto the queued connect-back when valid. */
  ownTag?: string
}

/** Write side, run only on the user's explicit "Add contact". A failed or impossible send lands in
 *  the outbox; neither a send nor a queue failure blocks the add. */
export async function confirmConnect(
  preview: ConnectPreview,
  deps: ConnectConfirmDeps,
): Promise<ConnectConfirmResult> {
  const result = await commitQRHandshake(preview, {
    addOrMergeContact: deps.addOrMergeContact,
    connectBackVersion: deps.connectBackVersion,
    ownTag: deps.ownTag,
    sendConnectBack: deps.sendConnectBack,
    enqueueFailedConnectBack: (entry) =>
      deps.queueConnectBack({ uuid: entry.content.uuid, ...entry }),
  })
  if (result.kind === "error" || result.kind === "conflict") return result
  return {
    kind: "added",
    contact: result.contact,
    navigateId: navigateIdFor(result.contact),
    pending: result.kind === "handshake-pending",
  }
}
