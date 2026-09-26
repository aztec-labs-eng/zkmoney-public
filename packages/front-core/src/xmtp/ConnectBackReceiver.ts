/**
 * ConnectBackReceiver — sharer-side orchestrator for the QR / link contact
 * handshake.
 *
 * A scanner (B) who resolved the sharer's (A's) encrypted connect sends an XMTP
 * **connect-back** carrying the redeemed `uuid` and, when they have one, their
 * claimed tag. This receiver runs on the *sharer's* device. Given the redeemed
 * `uuid` plus the authenticated sender's inbox addresses, it:
 *
 *   1. Looks the `uuid` up in `IssuedConnectStorage` — the local ledger of connects
 *      THIS device minted. No entry → the connect-back doesn't correspond to a
 *      connect we issued (unknown UUID, or a reinstall lost the store). Graceful
 *      `accepted`, no add. (v5 routes unknown UUIDs to a message request.)
 *   2. When the payload carries a claimed tag, `verifyClaimedTag` forward-resolves
 *      it and accepts it only if the tag's bootstrap address is on the sender's
 *      inbox. No tag or mismatch → add handle-only. A throw (registry 5xx) defers.
 *   3. Adds the scanner as a contact (provenance `"qr-scan"`), idempotent.
 *   4. Removes the local ledger entry (single-use). There is NO server blob to
 *      revoke in the serverless design — the uuid match + removal IS the
 *      single-add guard.
 *
 * **Never throws.** Every checked path returns a
 * discriminated status. Cursor semantics on the driver side:
 *   - `accepted` / `rejected` / `duplicate` → terminal, cursor advances.
 *   - `deferred` → transient failure (registry 5xx); cursor holds, the
 *     connect-back is re-presented next poll. The local entry is NOT removed on
 *     a defer, so a retry re-attempts cleanly.
 *
 * A permanent add conflict returns a terminal `accepted(false)` and may not
 * re-loop.
 *
 * Depends only on injected structural collaborators — no XMTP SDK. The mount injects
 * `createClaimedTagVerifier` over its Registry resolver.
 */

import type { Contact } from "../core/storages/ContactStorage.js"
import type { IssuedConnectRecord } from "../core/storages/IssuedConnectStorage.js"

/**
 * Accept a scanner-claimed tag only when the tag's registry bootstrap address is
 * one of the sender's inbox addresses.
 *
 *   - `{ tag, l2 }` on a match,
 *   - `null` when the tag is absent, unregistered, or owned by someone else,
 *   - **throws** on a transient failure (5xx / network). A throw is the only
 *     signal that the receiver should `defer` rather than proceed.
 */
export type ClaimedTagVerifier = (
  tag: string,
  senderXmtpAddresses: readonly string[],
) => Promise<{ tag: string; l2: string } | null>

/**
 * Local issued-connect ledger surface the receiver consumes. Structural subset of
 * `IssuedConnectStorage` so a hand-rolled fake satisfies it in tests, and the real
 * singleton satisfies it too.
 */
export interface IssuedConnectLookup {
  lookup(uuid: string): Promise<IssuedConnectRecord | null>
  remove(uuid: string): Promise<void>
}

/**
 * Contact add surface. Wraps `ContactStorage.addOrMergeContact` — the
 * no-op-on-duplicate path (keyed on L2 address). We never call the throwing
 * `addEntry` from here. Optional consent hook lets the mount mark the
 * conversation `allowed` once the mutual add lands.
 */
export interface ConnectBackContacts {
  addOrMergeContact(entry: Contact): Promise<Contact>
  /** Optional: mark the sender's conversation consented after a successful add. */
  allowConsent?(xmtpAddress: string): Promise<void>
}

export interface ConnectBackReceiverLogger {
  warn(message: string, context?: Record<string, unknown>): void
}

const noopLogger: ConnectBackReceiverLogger = { warn: () => undefined }

/** Input to `process`: the redeemed UUID + the authenticated sender. */
export interface ConnectBackInput {
  /** The redeemed handshake UUID echoed back by the scanner. */
  uuid: string
  /**
   * Every address on the authenticated sender's inbox, from `getDmPeerAddresses`. Empty (DM peer
   * not resolvable) is a terminal no-add — the connect-back cannot be attributed to a sender.
   */
  senderXmtpAddresses: readonly string[]
  /**
   * This device's own XMTP address, used to ignore self-sent connect-backs.
   * Optional — omit when the wiring can't supply it.
   */
  ownXmtpAddress?: string | null
  /**
   * Scanner-claimed tag from the connect-back payload, when present. Never
   * trusted alone — `verifyClaimedTag` forward-resolves it against the
   * authenticated sender.
   */
  claimedTag?: string | null
}

export type ConnectBackStatus =
  | { status: "accepted"; added: boolean }
  | { status: "deferred"; reason: ConnectBackDeferReason }

export type ConnectBackDeferReason = "claimed-tag-verifier-unavailable" | "unexpected-throw"

export class ConnectBackReceiver {
  constructor(
    private readonly issued: IssuedConnectLookup,
    private readonly contacts: ConnectBackContacts,
    private readonly verifyClaimedTag?: ClaimedTagVerifier,
    private readonly logger: ConnectBackReceiverLogger = noopLogger,
  ) {}

  async process(input: ConnectBackInput): Promise<ConnectBackStatus> {
    try {
      return await this.run(input)
    } catch (cause) {
      // The pipeline is designed so every checked path returns a discriminated
      // status. This catch is a safety net for the genuinely unexpected (e.g. a
      // store read throw). Surface as a defer so the driver retries rather than
      // silently burning the match.
      this.logger.warn("[ConnectBackReceiver] unexpected throw", {
        cause: describeCause(cause),
      })
      return { status: "deferred", reason: "unexpected-throw" }
    }
  }

  private async run(input: ConnectBackInput): Promise<ConnectBackStatus> {
    const { uuid, senderXmtpAddresses, ownXmtpAddress, claimedTag } = input

    // No authenticated sender → cannot attribute the add. Terminal, no add.
    const senderXmtpAddress = senderXmtpAddresses[0]
    if (!senderXmtpAddress) {
      return accepted(false)
    }

    // Self-sent connect-back (own DM) → ignore. Terminal, no add.
    const own = ownXmtpAddress?.toLowerCase()
    if (own && senderXmtpAddresses.some((a) => a.toLowerCase() === own)) {
      return accepted(false)
    }

    // 1. Local match. No entry → unknown UUID (never issued here, or reinstall
    //    lost the store). Graceful no-add; cursor advances so we don't re-loop.
    const record = await this.issued.lookup(uuid)
    if (!record) {
      return accepted(false)
    }

    // 2. A claimed tag is accepted only after a registry forward-resolve whose
    //    bootstrap address is on this sender's inbox. `null` is the COMMON
    //    tag-less / mismatched case — proceed handle-only. Only a THROW
    //    (5xx / network) defers; deleting the connect before we've confirmed
    //    the add would orphan state, so we hold the line and retry.
    let resolved: { tag: string; l2: string } | null = null
    if (claimedTag && this.verifyClaimedTag) {
      try {
        resolved = await this.verifyClaimedTag(claimedTag, senderXmtpAddresses)
      } catch (cause) {
        this.logger.warn("[ConnectBackReceiver] claimed-tag verifier threw", {
          senderXmtpAddresses,
          claimedTag,
          cause: describeCause(cause),
        })
        return { status: "deferred", reason: "claimed-tag-verifier-unavailable" }
      }
    }

    // 3. Add the scanner. Idempotent: `addOrMergeContact` no-ops on ANY
    //    duplicate identity (address / tag / name) and never throws on a dup.
    //    Tag-less scanners are added handle-only, keyed on their XMTP address
    //    so a later tagged add can enrich them.
    //
    //    Defense-in-depth: after the idempotent fix this should be unreachable,
    //    but a future storage error (or a regression) must NEVER re-loop a
    //    permanent add conflict. So ANY add throw → TERMINAL `accepted(false)`
    //    (not `deferred`): we couldn't add, but re-presenting the connect-back
    //    every poll would burn the budget without ever succeeding.
    const contact = buildContact(senderXmtpAddress, resolved)
    try {
      await this.contacts.addOrMergeContact(contact)
    } catch (cause) {
      this.logger.warn("[ConnectBackReceiver] addOrMergeContact threw — terminal no-add", {
        senderXmtpAddress,
        cause: describeCause(cause),
      })
      return accepted(false)
    }

    // 4. Clear the local ledger entry (single-use). There is no server blob to
    //    revoke in the serverless design — removing the local uuid IS the
    //    single-add guard. A partial-failure replay (add-ok-then-remove-failed →
    //    re-poll → lookup hits the still-present uuid → dup no-op add → remove)
    //    drains cleanly because `addOrMergeContact` is idempotent.
    await this.issued.remove(uuid)

    // 5. Optional consent bump — best-effort, never blocks the terminal status.
    if (this.contacts.allowConsent) {
      try {
        await this.contacts.allowConsent(senderXmtpAddress)
      } catch (cause) {
        this.logger.warn("[ConnectBackReceiver] allowConsent failed", {
          cause: describeCause(cause),
        })
      }
    }

    return accepted(true)
  }
}

/**
 * Build the contact row for the scanner. A verified claimed tag uses the L2
 * address + tag. Otherwise we store a pending handshake row keyed by the
 * sender's bootstrap address (a wallet inbox's only identity) so the contact
 * can be enriched later.
 */
function buildContact(
  senderXmtpAddress: string,
  resolved: { tag: string; l2: string } | null,
): Contact {
  if (resolved) {
    return {
      name: resolved.tag,
      address: resolved.l2,
      addressKind: "aztec-l2",
      tag: resolved.tag,
      verified: true,
      provenance: "qr-scan",
    }
  }
  // No verifiable tag. Key the row on the XMTP address so the add is still
  // idempotent and a later tagged connect-back can upgrade it. The sender
  // address is a 20-byte Ethereum/XMTP-format handle — NOT a 32-byte L2
  // address — so it is stored as pending handshake state, never `"aztec-l2"`.
  return {
    name: senderXmtpAddress,
    address: senderXmtpAddress,
    addressKind: "pending-handshake",
    provenance: "qr-scan",
  }
}

function accepted(added: boolean): ConnectBackStatus {
  return { status: "accepted", added }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`
  return String(cause)
}
