import { describe, expect, it } from "vitest"

import {
  ConnectBackReceiver,
  type ClaimedTagVerifier,
  type ConnectBackContacts,
  type IssuedConnectLookup,
} from "../../src/xmtp/ConnectBackReceiver"
import type { Contact } from "../../src/core/storages/ContactStorage"
import type { IssuedConnectRecord } from "../../src/core/storages/IssuedConnectStorage"

const UUID = "uuid-abc-123"
const SENDER_XMTP = "0xAbCdef0000000000000000000000000000001234"
const OWN_XMTP = "0x0000000000000000000000000000000000000000"
const RESOLVED = { tag: "bob", l2: "0x" + "11".repeat(32) }

const SAMPLE_RECORD: IssuedConnectRecord = {
  createdAt: 1_700_000_000_000,
}

class FakeIssued implements IssuedConnectLookup {
  lookupCalls: string[] = []
  removeCalls: string[] = []
  private entries = new Map<string, IssuedConnectRecord>()
  constructor(record: IssuedConnectRecord | null) {
    if (record) this.entries.set(UUID, record)
  }
  async lookup(uuid: string) {
    this.lookupCalls.push(uuid)
    return this.entries.get(uuid) ?? null
  }
  async remove(uuid: string) {
    this.removeCalls.push(uuid)
    this.entries.delete(uuid)
  }
}

class FakeContacts implements ConnectBackContacts {
  added: Contact[] = []
  store: Contact[] = []
  consentCalls: string[] = []
  constructor(hasConsent = false) {
    if (hasConsent) {
      ;(this as ConnectBackContacts).allowConsent = async (addr: string) => {
        this.consentCalls.push(addr)
      }
    }
  }
  async addOrMergeContact(entry: Contact): Promise<Contact> {
    const existing = this.store.find((e) => e.address.toLowerCase() === entry.address.toLowerCase())
    if (existing) return existing
    this.added.push(entry)
    this.store.push(entry)
    return entry
  }
}

function build(
  opts: {
    record?: IssuedConnectRecord | null
    verifyClaimedTag?: ClaimedTagVerifier
    contacts?: FakeContacts
  } = {},
) {
  const issued = new FakeIssued(opts.record === undefined ? SAMPLE_RECORD : opts.record)
  const contacts = opts.contacts ?? new FakeContacts()
  const verifyCalls: Array<{ tag: string; sender: string }> = []
  const verifyClaimedTag = opts.verifyClaimedTag
    ? async (tag, sender) => {
        verifyCalls.push({ tag, sender })
        return opts.verifyClaimedTag!(tag, sender)
      }
    : undefined
  const receiver = new ConnectBackReceiver(issued, contacts, verifyClaimedTag)
  return { receiver, issued, contacts, verifyCalls }
}

const tagged = {
  verifyClaimedTag: (async () => RESOLVED) satisfies ClaimedTagVerifier,
}

describe("ConnectBackReceiver (serverless)", () => {
  it("happy: matching UUID + claimed tag verifies → adds B, removes entry, accepted", async () => {
    const { receiver, issued, contacts, verifyCalls } = build(tagged)

    const result = await receiver.process({
      uuid: UUID,
      senderXmtpAddresses: [SENDER_XMTP],
      claimedTag: "bob",
    })

    expect(result).toEqual({ status: "accepted", added: true })
    expect(verifyCalls).toEqual([{ tag: "bob", sender: [SENDER_XMTP] }])
    expect(contacts.added).toHaveLength(1)
    expect(contacts.added[0]).toMatchObject({
      address: RESOLVED.l2,
      tag: RESOLVED.tag,
      provenance: "qr-scan",
      verified: true,
    })
    expect(issued.removeCalls).toEqual([UUID])
  })

  it("integration: a second connect-back for the same (removed) UUID → no double-add, accepted(false)", async () => {
    const { receiver, issued, contacts } = build(tagged)

    const first = await receiver.process({
      uuid: UUID,
      senderXmtpAddresses: [SENDER_XMTP],
      claimedTag: "bob",
    })
    expect(first).toEqual({ status: "accepted", added: true })
    expect(contacts.added).toHaveLength(1)
    expect(issued.removeCalls).toEqual([UUID])

    const second = await receiver.process({
      uuid: UUID,
      senderXmtpAddresses: [SENDER_XMTP],
      claimedTag: "bob",
    })
    expect(second).toEqual({ status: "accepted", added: false })
    expect(contacts.added).toHaveLength(1)
  })

  it("no claimed tag → pending handshake, remove, accepted (NOT deferred)", async () => {
    const { receiver, contacts, issued } = build()

    const result = await receiver.process({ uuid: UUID, senderXmtpAddresses: [SENDER_XMTP] })

    expect(result).toEqual({ status: "accepted", added: true })
    expect(contacts.added).toHaveLength(1)
    expect(contacts.added[0]).toMatchObject({
      address: SENDER_XMTP,
      addressKind: "pending-handshake",
      provenance: "qr-scan",
    })
    expect(contacts.added[0].tag).toBeUndefined()
    expect(issued.removeCalls).toEqual([UUID])
  })

  it("claimed-tag verifier throw → deferred, entry kept; retry succeeds", async () => {
    let shouldThrow = true
    const { receiver, contacts, issued } = build({
      verifyClaimedTag: async () => {
        if (shouldThrow) throw new Error("registry 503")
        return RESOLVED
      },
    })

    const first = await receiver.process({
      uuid: UUID,
      senderXmtpAddresses: [SENDER_XMTP],
      claimedTag: "bob",
    })
    expect(first).toEqual({ status: "deferred", reason: "claimed-tag-verifier-unavailable" })
    expect(contacts.added).toHaveLength(0)
    expect(issued.removeCalls).toHaveLength(0)

    shouldThrow = false
    const second = await receiver.process({
      uuid: UUID,
      senderXmtpAddresses: [SENDER_XMTP],
      claimedTag: "bob",
    })
    expect(second).toEqual({ status: "accepted", added: true })
    expect(contacts.added).toHaveLength(1)
    expect(issued.removeCalls).toEqual([UUID])
  })

  it("edge: unknown UUID / lost local store (reinstall) → no add, accepted", async () => {
    const { receiver, contacts, issued } = build({ record: null })

    const result = await receiver.process({ uuid: UUID, senderXmtpAddresses: [SENDER_XMTP] })

    expect(result).toEqual({ status: "accepted", added: false })
    expect(contacts.added).toHaveLength(0)
    expect(issued.removeCalls).toHaveLength(0)
  })

  it("edge: sender null → no add, terminal (accepted), no lookup", async () => {
    const { receiver, contacts, issued } = build()

    const result = await receiver.process({ uuid: UUID, senderXmtpAddresses: [] })

    expect(result).toEqual({ status: "accepted", added: false })
    expect(contacts.added).toHaveLength(0)
    expect(issued.lookupCalls).toHaveLength(0)
  })

  it("edge: own-address sender → no add, terminal (accepted)", async () => {
    const { receiver, contacts } = build()

    const result = await receiver.process({
      uuid: UUID,
      senderXmtpAddresses: [OWN_XMTP.toUpperCase()],
      ownXmtpAddress: OWN_XMTP,
    })

    expect(result).toEqual({ status: "accepted", added: false })
    expect(contacts.added).toHaveLength(0)
  })

  it("edge: B already a contact → no-op add, still removes entry + accepted", async () => {
    const contacts = new FakeContacts()
    contacts.store.push({ name: "existing", address: RESOLVED.l2, addressKind: "aztec-l2" })
    const { receiver, issued } = build({ contacts, ...tagged })

    const result = await receiver.process({
      uuid: UUID,
      senderXmtpAddresses: [SENDER_XMTP],
      claimedTag: "bob",
    })

    expect(result).toEqual({ status: "accepted", added: true })
    expect(contacts.added).toHaveLength(0)
    expect(issued.removeCalls).toEqual([UUID])
  })

  it("optional consent: calls allowConsent after a successful add", async () => {
    const contacts = new FakeContacts(true)
    const { receiver } = build({ contacts })

    const result = await receiver.process({ uuid: UUID, senderXmtpAddresses: [SENDER_XMTP] })

    expect(result).toEqual({ status: "accepted", added: true })
    expect(contacts.consentCalls).toEqual([SENDER_XMTP])
  })

  it("permanent add conflict: addOrMergeContact throws → TERMINAL accepted(false), entry NOT removed", async () => {
    const throwingContacts: ConnectBackContacts = {
      addOrMergeContact: async () => {
        throw new Error("permanent storage conflict")
      },
    }
    const issued = new FakeIssued(SAMPLE_RECORD)
    const receiver = new ConnectBackReceiver(issued, throwingContacts)

    const result = await receiver.process({ uuid: UUID, senderXmtpAddresses: [SENDER_XMTP] })

    expect(result).toEqual({ status: "accepted", added: false })
    expect(result.status).not.toBe("deferred")
    expect(issued.removeCalls).toHaveLength(0)
  })

  it("never throws: a store lookup throw surfaces as deferred (unexpected-throw)", async () => {
    const issued: IssuedConnectLookup = {
      lookup: async () => {
        throw new Error("disk read error")
      },
      remove: async () => {},
    }
    const receiver = new ConnectBackReceiver(issued, new FakeContacts())

    const result = await receiver.process({ uuid: UUID, senderXmtpAddresses: [SENDER_XMTP] })
    expect(result).toEqual({ status: "deferred", reason: "unexpected-throw" })
  })

  it("claimed tag that does not match the sender → handle-only, not deferred", async () => {
    const { receiver, contacts } = build({
      verifyClaimedTag: async () => null,
    })

    const result = await receiver.process({
      uuid: UUID,
      senderXmtpAddresses: [SENDER_XMTP],
      claimedTag: "imposter",
    })

    expect(result).toEqual({ status: "accepted", added: true })
    expect(contacts.added[0]).toMatchObject({
      address: SENDER_XMTP,
      addressKind: "pending-handshake",
    })
    expect(contacts.added[0].tag).toBeUndefined()
  })
})
