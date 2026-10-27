/** The connect-back auto-add notice: display name, dedupe id, and the contact-detail route id. */
import { describe, expect, it } from "vitest"
import { contactAddedNotificationInput } from "../../../src/core/services/notifications/contactAddedNotification"
import type { Contact } from "../../../src/core/storages/ContactStorage"

const L2 = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"

describe("contactAddedNotificationInput", () => {
  it("routes a tagged contact by tag and names it @tag", () => {
    const input = contactAddedNotificationInput(
      {
        name: "bob",
        address: L2,
        addressKind: "aztec-l2",
        tag: "bob",
        provenance: "qr-scan",
      } as Contact,
      42,
    )
    expect(input.target).toEqual({ type: "contact.added", contactId: "bob" })
    expect(input.description).toContain("@bob")
    expect(input.timestampMs).toBe(42)
  })

  it("routes a tag-less handshake row by address, shortened for display", () => {
    const xmtp = "0xAbCdEf0000000000000000000000000000000001"
    const input = contactAddedNotificationInput(
      {
        name: xmtp,
        address: xmtp,
        addressKind: "pending-handshake",
        provenance: "qr-scan",
      } as Contact,
      1,
    )
    expect(input.target).toEqual({ type: "contact.added", contactId: xmtp })
    expect(input.description).toContain("0xAbCd...0001")
    // Dedupe is case-insensitive: a second connect-back from the same peer re-mints nothing.
    expect(input.id).toBe(`contact:added:${xmtp.toLowerCase()}`)
  })
})
