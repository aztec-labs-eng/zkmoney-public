/**
 * Web implementations of the front-core receiver ports (stage-3 inbox): sender-tag resolution over
 * the Registry (always a fresh manifest — the contact cache never vouches for a sender) and
 * store writes over the web singletons (RequestStorage, ContactStorage). Transfer receive is
 * chain-native (`TransferScannerMount`), not an XMTP port.
 */

import {
  incomingRequestToRow,
  type Contact,
  type ContactsByL2,
  type IncomingRequestInput,
  type RequestStorage,
  type RequestStoreWrites,
  type RequestTagBindingResolver,
  type RequestTerminalStatus,
} from "@obsidion/front-core"
import { verifyTag } from "../../features/contacts/registryResolution"

/**
 * Contact lookup + auto-add for transfer attribution. `registerL2`: a first-time
 * verified sender (tag registry-resolved and proven against the on-chain event) is added to the
 * contact book via the idempotent `addOrMergeContact` — an existing colliding row wins unchanged,
 * EXCEPT a `pending-handshake` row, which that method replaces outright. This path skips those, so
 * an unsolicited transfer can never finish a handshake the user is still waiting on.
 */
export function createContactsByL2(contacts: {
  getEntries(): Promise<Contact[]>
  addOrMergeContact(entry: Contact): Promise<Contact>
}): ContactsByL2 {
  return {
    async findByL2Address(addr: string): Promise<{ tag: string } | null> {
      try {
        const needle = addr.toLowerCase()
        const match = (await contacts.getEntries()).find(
          (e) =>
            e.tag &&
            (e.addressKind ?? "aztec-l2") === "aztec-l2" &&
            e.address.toLowerCase() === needle,
        )
        return match?.tag ? { tag: match.tag } : null
      } catch {
        return null
      }
    },
    async registerL2({ tag, l2Address }: { tag: string; l2Address: string }): Promise<void> {
      // A stranger who claims a tag the user is mid-handshake with could otherwise take over that
      // contact by sending dust: the merge REPLACES a pending row on a tag/name collision.
      const needle = tag.toLowerCase()
      const entries = await contacts.getEntries().catch(() => [] as Contact[])
      const collidesWithPending = entries.some(
        (e) =>
          (e.addressKind as string | undefined) === "pending-handshake" &&
          ((e.tag ?? "").toLowerCase() === needle || (e.name ?? "").toLowerCase() === needle),
      )
      if (collidesWithPending) return

      await contacts.addOrMergeContact({
        name: tag,
        address: l2Address,
        addressKind: "aztec-l2",
        tag,
        verified: true,
      })
    },
  }
}

/**
 * Sender lookup for the request receiver: a tag's Registry bootstrap address, always over a fresh
 * manifest. Tag not resolvable → null (skip); transport throw propagates so the receiver defers.
 */
export function createRequestBindingResolver(
  verify: (tag: string) => Promise<{ xmtpAddress?: string } | null> = verifyTag,
): RequestTagBindingResolver {
  return {
    async resolveXmtpBinding(tag: string): Promise<string | null> {
      const record = await verify(tag)
      return record?.xmtpAddress ?? null
    },
  }
}

/** Receiver writes over the front-core `RequestStorage`, via the shared row mapping. */
export function createRequestStoreWrites(store: RequestStorage): RequestStoreWrites {
  return {
    findById: (requestId: string) => store.findById(requestId),
    addIncomingRequest: (input: IncomingRequestInput) =>
      store.addIfAbsent(incomingRequestToRow(input)),
    applyStatus: (requestId, status: RequestTerminalStatus, txHash?: string) =>
      store.applyStatus(requestId, status, txHash),
  }
}
