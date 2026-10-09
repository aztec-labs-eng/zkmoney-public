import type { Contact } from "../storages/ContactStorage"
import type { HandshakeInlinePacket } from "./handshakeInlineCodec"
import { parseConnectLink, parseUserTagFromQRPayload } from "./connectLink"
import { CONNECT_FORMAT_VERSION } from "./shareCore"
import { normalizeTag } from "../../utils/normalizeTag"

/** Connect-back wire content. Optional `tag` is the scanner's own handle. */
export type ConnectBackWire = { version: number; uuid: string; tag?: string }

function connectBackContent(version: number, uuid: string, ownTag?: string): ConnectBackWire {
  const content: ConnectBackWire = { version, uuid }
  if (ownTag) {
    const tag = normalizeTag(ownTag)
    if (tag) content.tag = tag
  }
  return content
}

/**
 * Pure scanner-side core for the serverless QR / link contact handshake. The platform React hooks
 * wrap this with storage / XMTP / router wiring; the
 * parse→decode→add→connect-back orchestration is unit-testable with plain injected collaborators —
 * the packet is decoded by an injected `decodeInline` (the codec beside this module), no server fetch.
 *
 * The scanner is the SINGLE owner of a scan: it tries `parseConnectLink` FIRST
 * and only falls back to the legacy bare-tag `openTag` path when that returns
 * `null`. A `/connect#…` scan therefore never also fires the bare-tag add path
 * (no double-add / double-fire).
 */

/* -------------------------------------------------------------------------- */
/*  Error copy (distinct, user-facing)                                        */
/* -------------------------------------------------------------------------- */

/** Malformed packet / decode failure / unknown version or kind → opaque "invalid". */
export const ERR_INVALID = "Invalid QR code"
/**
 * The link's tag IS registered, but the connect's claimed address(es) don't
 * match the registry (source of truth) — a spoof/forgery. We reject hard (no
 * contact, no connect-back). A tag the registry doesn't know is NOT a mismatch
 * (that's a non-discoverable user — allowed through unverified).
 */
export const ERR_TAG_MISMATCH = "Couldn't verify this code — it may be unsafe"

/* -------------------------------------------------------------------------- */
/*  Result types                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The outcome the React layer renders + navigates on. Discriminated so the
 * caller can branch without inspecting strings.
 *
 *   • `not-a-connect`   — not a handshake link; the caller falls back to the
 *                       legacy bare-tag `openTag` path (or ignores it).
 *   • `self-scan`    — the scanned code is the user's own; ignored silently.
 *   • `handshake`    — resolved + sharer added; `navigateId` is the contact id
 *                       to open the chat for. `connectBack` was kicked off
 *                       fire-and-forget (its result does not gate this status).
 *   • `handshake-pending` — resolved + pending handshake row stored, but no L2
 *                       address was available from the packet or registry yet.
 *                       `connectBack` was still kicked off fire-and-forget.
 *   • `error`        — clean failure (malformed/tampered packet, unknown
 *                       version/kind); NO partial contact, NO connect-back.
 */
export type QRHandshakeScanResult =
  | { kind: "not-a-connect"; bareTag: string | null }
  | { kind: "self-scan" }
  | { kind: "handshake"; contact: Contact; navigateId: string }
  | { kind: "handshake-pending"; contact: Contact }
  /** The scanned tag was not saved: `contact`, a stored row under another tag, matched the scan. */
  | { kind: "conflict"; contact: Contact }
  | { kind: "error"; message: string }

/** Collaborators the pure scan core needs — injected so the flow is testable. */
export interface QRHandshakeScanDeps {
  /**
   * Decode the inline packet locally (no network). Throws fail-closed on a
   * malformed / tampered packet or an unknown format/chain/kind.
   */
  decodeInline: (packet: string) => HandshakeInlinePacket
  /** Add (or no-op-merge) the sharer as a contact. Returns the resulting contact. */
  addOrMergeContact: (entry: Contact) => Promise<Contact>
  /**
   * Send the connect-back to the sharer. Fire-and-forget: the scan succeeds
   * even when this rejects or reports `recipient-not-reachable`.
   */
  sendConnectBack: (peerXmtp: string, content: ConnectBackWire) => Promise<unknown>
  /** Connect-back wire schema version (sdk `CONNECT_BACK_VERSION`). */
  connectBackVersion: number
  /**
   * Persist a connect-back whose send FAILED (peer unreachable at scan time, or
   * a `dm.send` throw) so a later foreground/connectivity flush can resend it.
   * Optional — when absent, a failed send is simply logged-and-dropped (the
   * pre-outbox behavior). A successful send never enqueues.
   */
  enqueueFailedConnectBack?: (entry: {
    peerXmtp: string
    content: ConnectBackWire
  }) => Promise<void>
  /** Own XMTP handle (lowercased compare) for self-scan detection; may be undefined. */
  ownXmtpHandle?: string
  /** Own L2 address (lowercased compare) for self-scan detection; may be undefined. */
  ownL2Address?: string
  /**
   * Scanner's own tag, stamped onto the connect-back so the sharer can
   * forward-resolve it. Omitted when absent or invalid.
   */
  ownTag?: string
  /** Optional logger seam (defaults to console). */
  log?: (msg: string, ...args: unknown[]) => void
  /**
   * Authoritative registry forward-resolve for the link's tag. Resolves to the
   * tag's registered identity, `null` when the tag isn't registered (404 /
   * retired → the user is non-discoverable, which is fine), and THROWS on a
   * transient failure (5xx / network) so the caller can fail open. MUST hit the
   * registry directly (not a local-contact cache) so a previously-added
   * malicious contact can't "confirm" itself. Optional: when absent the scan
   * behaves as before (no cross-check).
   */
  verifyTag?: (tag: string) => Promise<{ l2Address?: string; xmtpAddress?: string } | null>
}

/* -------------------------------------------------------------------------- */
/*  Version validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The connect `version` is `{format}:{chain}` (e.g. `"1.0:testnet"`). We accept a
 * connect only when its FORMAT part matches the format this build mints
 * (`CONNECT_FORMAT_VERSION`). The chain part is intentionally NOT gated here —
 * cross-chain handling is a richer concern; an unknown FORMAT is the hard
 * reject the plan calls for (a foreign / future wire shape we can't parse).
 */
export function isSupportedConnectVersion(version: string): boolean {
  if (typeof version !== "string" || version.length === 0) return false
  const format = version.split(":")[0]
  return format === CONNECT_FORMAT_VERSION
}

/* -------------------------------------------------------------------------- */
/*  Self-scan detection                                                       */
/* -------------------------------------------------------------------------- */

function isSelfScan(payload: HandshakeInlinePacket, deps: QRHandshakeScanDeps): boolean {
  const handle = payload.xmtpHandle?.toLowerCase()
  const l2 = payload.l2Address?.toLowerCase()
  if (deps.ownXmtpHandle && handle && deps.ownXmtpHandle.toLowerCase() === handle) return true
  if (deps.ownL2Address && l2 && deps.ownL2Address.toLowerCase() === l2) return true
  return false
}

/* -------------------------------------------------------------------------- */
/*  Contact construction                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Build the `Contact` entry for a scanned sharer. The packet's `tag` doubles as the display name
 * AND the L2 `tag` used to route payments / open the chat — without it the contact is invisible to
 * the payment directory and the contact-request rail. A tag-less packet (non-discoverable sharer)
 * falls back to the handle as the display name and leaves `tag` unset.
 *
 * `address` is a real L2 address when one is known. If the packet omitted
 * `l2Address`, the caller may pass a registry-resolved L2 address. If neither
 * exists, the contact is stored as `pending-handshake`: its address is the XMTP
 * handle used to finish the handshake, not a payment route.
 */
export function buildScannedContact(
  payload: HandshakeInlinePacket,
  verified = false,
  resolvedL2Address = payload.l2Address,
): Contact {
  // The codec already pins the tag to the registry charset, lowercase included.
  const tag = payload.tag
  const contact: Contact = {
    name: tag ?? payload.xmtpHandle,
    address: resolvedL2Address ?? payload.xmtpHandle,
    addressKind: (resolvedL2Address ? "aztec-l2" : "pending-handshake") as Contact["addressKind"],
    provenance: "qr-scan",
    verified,
  }
  if (tag) contact.tag = tag
  return contact
}

/* -------------------------------------------------------------------------- */
/*  Registry cross-check (source-of-truth verification)                       */
/* -------------------------------------------------------------------------- */

export type RegistryMatch = "match" | "mismatch" | "indeterminate"

/**
 * Compare a decrypted connect payload against the registry's record for the
 * link's tag:
 *   • `mismatch`      — a claimed address contradicts the registry → a spoof.
 *   • `match`         — at least one shared field agreed and none contradicted.
 *   • `indeterminate` — no overlapping comparable field (can't confirm, but
 *                       nothing was contradicted either).
 *
 * Both `l2Address` values are canonical (`AztecAddress.toString()`) and
 * `xmtpHandle`/`xmtpAddress` are EVM addresses, so a lowercase compare is
 * sufficient — no `@aztec/stdlib` runtime import needed here.
 */
export function matchesRegistry(
  payload: HandshakeInlinePacket,
  record: { l2Address?: string; xmtpAddress?: string },
): RegistryMatch {
  const lc = (s: string) => s.toLowerCase()
  let compared = 0
  if (payload.l2Address && record.l2Address) {
    compared++
    if (lc(payload.l2Address) !== lc(record.l2Address)) return "mismatch"
  }
  if (payload.xmtpHandle && record.xmtpAddress) {
    compared++
    if (lc(payload.xmtpHandle) !== lc(record.xmtpAddress)) return "mismatch"
  }
  return compared > 0 ? "match" : "indeterminate"
}

/**
 * The id the payments tab navigates by (`openContactId`). For an L2 contact
 * the directory keys rows by `tag` when present, else by address — mirror that
 * here so a freshly-added sharer resolves on navigation.
 */
export function navigateIdFor(contact: Contact): string {
  return contact.tag ?? contact.address
}

/**
 * A connect-back send is "undeliverable" only when it returns an explicit
 * `{ ok: false }` (e.g. `recipient-not-reachable`). Anything else — `{ ok: true }`,
 * or a non-discriminated truthy result from a test fake — counts as delivered.
 */
function isUndeliverable(res: unknown): boolean {
  return typeof res === "object" && res !== null && (res as { ok?: unknown }).ok === false
}

/* -------------------------------------------------------------------------- */
/*  Preview half (decode + verify, no writes)                                 */
/* -------------------------------------------------------------------------- */

/** Everything the commit half needs, produced by a successful preview. */
export interface QRHandshakePreview {
  contact: Contact
  packet: HandshakeInlinePacket
  verified: boolean
  pending: boolean
}

export type QRHandshakePreviewResult =
  | { kind: "not-a-connect"; bareTag: string | null }
  | { kind: "self-scan" }
  | { kind: "preview"; preview: QRHandshakePreview }
  | { kind: "error"; message: string }

export interface QRHandshakePreviewDeps {
  decodeInline: QRHandshakeScanDeps["decodeInline"]
  verifyTag?: QRHandshakeScanDeps["verifyTag"]
  /**
   * Platform self-scan predicate — everything it compares (XMTP handle, L2 address, tag) is in the
   * packet. Absent → no self-scan detection.
   */
  isSelfScan?: (packet: HandshakeInlinePacket) => boolean
  log?: QRHandshakeScanDeps["log"]
}

/**
 * The read-only half of a scan: parse → decode → kind/version check →
 * self-scan → registry cross-check → build the contact. No storage write, no
 * connect-back — web inserts a user confirmation between this and
 * `commitQRHandshake`; `runQRHandshakeScan` composes both.
 *
 * Ordering is load-bearing:
 *   1. `parseConnectLink` FIRST — a non-connect payload returns `not-a-connect` and the
 *      caller falls back to the bare-tag path. A `/connect#…` link never reaches
 *      the bare-tag parser, so the two paths can't both fire for one scan.
 *   2. decode → kind-check → version-check → self-scan → registry cross-check.
 */
export async function previewQRHandshake(
  payload: string,
  deps: QRHandshakePreviewDeps,
): Promise<QRHandshakePreviewResult> {
  const log = deps.log ?? (() => {})

  const encoded = parseConnectLink(payload)
  if (!encoded) {
    // Not a handshake link — hand the scan to the legacy bare-tag path.
    return { kind: "not-a-connect", bareTag: parseUserTagFromQRPayload(payload) }
  }

  let resolved: HandshakeInlinePacket
  try {
    resolved = deps.decodeInline(encoded)
  } catch (err) {
    // Fail-closed: a malformed / tampered packet (or an unknown
    // format/chain/kind) surfaces as the opaque "Invalid QR code". No add,
    // no connect-back.
    log("[useQRHandshakeScan] inline decode failed", err)
    return { kind: "error", message: ERR_INVALID }
  }

  // Only the handshake kind is handled today; a known-but-unsupported future
  // kind (payment-request / privacy) is rejected here. (The codec already
  // rejects an UNKNOWN kind int — this guards a kind the codec knows but the
  // scanner doesn't yet handle.)
  if (resolved.kind !== "handshake") {
    log("[useQRHandshakeScan] unsupported connect kind", resolved.kind)
    return { kind: "error", message: ERR_INVALID }
  }

  // Reject an unknown wire format (R2/R11) — no add, no connect-back.
  if (!isSupportedConnectVersion(resolved.version)) {
    log("[useQRHandshakeScan] rejecting unknown connect version", resolved.version)
    return { kind: "error", message: ERR_INVALID }
  }

  // Self-scan: scanning your own code adds nothing and connects back to nobody.
  if (deps.isSelfScan?.(resolved)) {
    log("[useQRHandshakeScan] ignoring self-scan")
    return { kind: "self-scan" }
  }

  // Cross-check the packet's tag against the registry (source of truth). A
  // discoverable tag whose claimed address(es) DON'T match is a spoof → reject.
  // A tag the registry doesn't know (`null`) is non-discoverable → proceed
  // unverified. A transient registry failure FAILS OPEN (proceed unverified) —
  // the gateway is off the handshake critical path by design. Only runs when
  // the packet carries a tag AND a verifier is wired.
  let verified = false
  let resolvedL2Address = resolved.l2Address
  if (resolved.tag && deps.verifyTag) {
    let record: { l2Address?: string; xmtpAddress?: string } | null = null
    try {
      record = await deps.verifyTag(resolved.tag)
    } catch (err) {
      log("[useQRHandshakeScan] tag verify unavailable — proceeding unverified", err)
      record = null
    }
    if (record) {
      const match = matchesRegistry(resolved, record)
      if (match === "mismatch") {
        log("[useQRHandshakeScan] registry mismatch — rejecting scan", {
          tag: resolved.tag,
          claimedXmtpHandle: resolved.xmtpHandle,
          claimedL2Address: resolved.l2Address,
        })
        return { kind: "error", message: ERR_TAG_MISMATCH }
      }
      verified = match === "match"
      resolvedL2Address ??= record.l2Address
    }
  }

  const contact = buildScannedContact(resolved, verified, resolvedL2Address)
  return {
    kind: "preview",
    preview: {
      contact,
      packet: resolved,
      verified,
      pending: (contact.addressKind as string) === "pending-handshake",
    },
  }
}

/* -------------------------------------------------------------------------- */
/*  Commit half (add + connect-back)                                          */
/* -------------------------------------------------------------------------- */

export type QRHandshakeCommitResult = Extract<
  QRHandshakeScanResult,
  { kind: "handshake" | "handshake-pending" | "conflict" | "error" }
>

export interface QRHandshakeCommitDeps {
  addOrMergeContact: QRHandshakeScanDeps["addOrMergeContact"]
  connectBackVersion: number
  /**
   * Optional live send. When absent (no client on this device or tab), EVERY
   * commit goes straight to `enqueueFailedConnectBack` for a later flush.
   */
  sendConnectBack?: QRHandshakeScanDeps["sendConnectBack"]
  enqueueFailedConnectBack?: QRHandshakeScanDeps["enqueueFailedConnectBack"]
  log?: QRHandshakeScanDeps["log"]
  /** Scanner's own tag, stamped onto the connect-back when valid. */
  ownTag?: string
}

/**
 * The write half: add the sharer, then connect back. With `sendConnectBack`
 * the send is fire-and-forget (it never gates the result; a failed send is
 * enqueued for retry). Without it the connect-back is enqueued directly; an
 * enqueue failure never blocks the add. A conflict sends no connect-back.
 */
export async function commitQRHandshake(
  preview: QRHandshakePreview,
  deps: QRHandshakeCommitDeps,
): Promise<QRHandshakeCommitResult> {
  const log = deps.log ?? (() => {})
  const resolved = preview.packet

  // Add the sharer. If no L2 address is known yet, this creates a pending row:
  // the address is an XMTP transport handle and must not be treated as payment
  // routing state.
  let contact: Contact
  try {
    contact = await deps.addOrMergeContact(preview.contact)
  } catch (err) {
    // A failed add is the only thing that can leave nothing useful; surface
    // it as a generic error so no half-state navigation happens.
    log("[useQRHandshakeScan] addOrMergeContact failed", err)
    return { kind: "error", message: ERR_INVALID }
  }

  const scannedTag = preview.contact.tag?.toLowerCase()
  if (scannedTag && contact.tag?.toLowerCase() !== scannedTag) {
    log("[useQRHandshakeScan] scanned tag not saved: a contact under another tag matched", {
      scannedTag,
      existingTag: contact.tag,
    })
    return { kind: "conflict", contact }
  }

  log("[useQRHandshakeScan] added contact from QR scan", {
    name: contact.name,
    tag: contact.tag,
    address: contact.address,
    addressKind: contact.addressKind,
    provenance: contact.provenance,
    verified: contact.verified,
    sharerXmtpHandle: resolved.xmtpHandle,
    uuid: resolved.uuid,
  })

  const content = connectBackContent(deps.connectBackVersion, resolved.uuid, deps.ownTag)
  const peerXmtp = resolved.xmtpHandle
  if (deps.sendConnectBack) {
    // Connect-back is fire-and-forget — a `recipient-not-reachable` (or any
    // rejection) must NOT error the flow or block navigation. But a FAILED send
    // (peer offline at scan, or a throw) is enqueued to the retry outbox so the
    // mutual-add isn't silently dropped; a later flush resends it. The recipient
    // simply being offline is already handled by XMTP mailbox delivery (a
    // successful send), so only a non-`ok` / throwing send enqueues.
    void deps
      .sendConnectBack(peerXmtp, content)
      .then(async (res) => {
        if (isUndeliverable(res)) {
          log("[useQRHandshakeScan] connect-back undeliverable — enqueuing for retry", res)
          await deps.enqueueFailedConnectBack?.({ peerXmtp, content })
        }
      })
      .catch(async (err) => {
        log("[useQRHandshakeScan] sendConnectBack threw — enqueuing for retry", err)
        try {
          await deps.enqueueFailedConnectBack?.({ peerXmtp, content })
        } catch (enqErr) {
          log("[useQRHandshakeScan] enqueue failed (dropped)", enqErr)
        }
      })
  } else {
    try {
      await deps.enqueueFailedConnectBack?.({ peerXmtp, content })
    } catch (err) {
      log("[useQRHandshakeScan] connect-back queue failed (dropped)", err)
    }
  }

  if ((contact.addressKind as string | undefined) === "pending-handshake") {
    return { kind: "handshake-pending", contact }
  }
  return { kind: "handshake", contact, navigateId: navigateIdFor(contact) }
}

/* -------------------------------------------------------------------------- */
/*  Orchestration                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Drive one scanned payload to a terminal result: preview + commit in one shot.
 * Never throws — errors map to a
 * `{ kind: "error" }` result. The contact is added before the caller
 * navigates; connect-back never gates the result.
 */
export async function runQRHandshakeScan(
  payload: string,
  deps: QRHandshakeScanDeps,
): Promise<QRHandshakeScanResult> {
  const previewed = await previewQRHandshake(payload, {
    decodeInline: deps.decodeInline,
    verifyTag: deps.verifyTag,
    isSelfScan: (packet) => isSelfScan(packet, deps),
    log: deps.log,
  })
  if (previewed.kind !== "preview") return previewed
  return commitQRHandshake(previewed.preview, deps)
}

/* -------------------------------------------------------------------------- */
/*  Synchronous re-entrancy guard                                             */
/* -------------------------------------------------------------------------- */

/** A 1-cell mutable holder (a `useRef`-like seam, but plain so it's testable). */
export interface ReentrancyGuard {
  inFlight: boolean
}

/** The result a re-entrant (already-in-flight) `scan` returns. */
export const ERR_SCAN_IN_FLIGHT = "Already processing a scan"

/**
 * Run `body` under a SYNCHRONOUS in-flight guard. A camera scanner can fire
 * `onScanResult` twice in the same event-loop turn (before any `busy`
 * re-render lands), so the gate must flip BEFORE the first `await` — async
 * state can't catch the second call. The guard flips synchronously here and
 * resets in `finally`; a second call while the first is in flight returns the
 * `error` short-circuit without running `body` (no double add / connect-back).
 *
 * Pulled out of the React hook as a pure helper so the same-tick double-fire
 * guarantee is unit-testable without the router / XMTP / crypto import chain
 * the full hook drags in.
 */
export async function withReentrancyGuard(
  guard: ReentrancyGuard,
  body: () => Promise<QRHandshakeScanResult>,
): Promise<QRHandshakeScanResult> {
  if (guard.inFlight) {
    return { kind: "error", message: ERR_SCAN_IN_FLIGHT }
  }
  guard.inFlight = true
  try {
    return await body()
  } finally {
    guard.inFlight = false
  }
}
