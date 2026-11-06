/**
 * U10 — web inbox adapters + chain-native ingest. Pure-module tests: the scanner and receivers run
 * against fakes for the event source / registry, and against the real web store adapters over
 * in-memory storage.
 */

import { describe, expect, it } from "vitest"
import {
  ContactStorage,
  RequestReceiver,
  createRequests,
  memoryStore,
  TagValidationError,
  TransferEventScanner,
  createActivity,
  memoryBackend,
  openDatabase,
  type Database,
  type Activity,
  type TokenTransaction,
  approvedContactTags,
  contactRowFromEntry,
  isFromNonContact,
  isPaymentContactEntry,
  type Contact,
  type IStorageAdapter,
  type ScannedTransferEvent,
  createTagForwardResolver,
} from "@obsidion/front-core"
import {
  createContactsByL2,
  createRequestSenderPolicy,
  createRequestStoreWrites,
} from "../../../src/platform/xmtp/adapters"

const memRequests = () =>
  createRequests({
    db: openDatabase(memoryBackend()),
    payments: memoryStore({ rows: [], deposits: [], loaded: true, failed: false }).readonly,
  })

const TX_HASH = `0x${"ab".repeat(32)}`
const SENDER_L2 = `0x${"11".repeat(32)}`
const ACCOUNT_L2 = `0x${"22".repeat(32)}`
const TOKEN = `0x${"33".repeat(32)}`

const currentAccount = { tag: "bob", l2Address: ACCOUNT_L2, rollupId: "aztec-dev" }

function memStorage(): IStorageAdapter {
  const m = new Map<string, string>()
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, v)
    },
    removeItem: async (k) => {
      m.delete(k)
    },
    clear: async () => {
      m.clear()
    },
  }
}

/** Each test store's database, which its scan cursor shares. */
const dbOf = new WeakMap<Activity, Database>()

/** A fresh activity store over memory. */
async function freshTxStorage(_storage: IStorageAdapter): Promise<Activity> {
  const db = openDatabase(memoryBackend())
  const activity = createActivity({ db })
  dbOf.set(activity, db)
  return activity
}

const tags = { resolveL2: async () => ({ l2Address: SENDER_L2 }) }

function scannedEvent(overrides: Partial<ScannedTransferEvent> = {}): ScannedTransferEvent {
  return {
    txHash: TX_HASH,
    from: SENDER_L2,
    to: ACCOUNT_L2,
    amount: "1000000",
    blockNumber: 5,
    senderTag: "alice",
    ...overrides,
  }
}

function scannerOver(
  txStorage: Activity,
  contacts: ReturnType<typeof createContactsByL2>,
  events: ScannedTransferEvent[],
): TransferEventScanner {
  return new TransferEventScanner({
    source: {
      headBlock: async () => 10,
      listIncoming: async () => events,
      blockTimestampMs: async (b) => b * 1000,
    },
    db: dbOf.get(txStorage)!,
    transactionStore: txStorage,
    tags,
    contacts,
    token: { address: TOKEN, symbol: "DAI", decimals: 6 },
  })
}

const scanContext = {
  accountAddress: ACCOUNT_L2,
  accountTag: currentAccount.tag,
  networkId: currentAccount.rollupId,
}

function contactStoreFake(entries: Contact[]) {
  const writes: Contact[] = []
  return {
    writes,
    getEntries: async () => entries,
    addEntry: async (e: Contact) => {
      writes.push(e)
    },
    addOrMergeContact: async (e: Contact) => {
      writes.push(e)
      return e
    },
  }
}

describe("web chain-native transfer ingest", () => {
  it("ingests a scanned transfer through the real web adapters", async () => {
    const storage = memStorage()
    const txStorage = await freshTxStorage(storage)
    const contacts = contactStoreFake([])
    const scanner = scannerOver(txStorage, createContactsByL2(contacts), [scannedEvent()])
    await scanner.pass(scanContext, { full: true })

    const row = (await txStorage.byHash(TX_HASH)) as TokenTransaction | undefined
    expect(row).toBeDefined()
    expect(row!.to).toBe("bob")
    // Unknown sender attributes by the registry-verified meta tag and auto-adds to the contact book.
    expect(row!.from).toBe("alice")
    expect(row!.senderL2Address).toBe(SENDER_L2)
    expect(contacts.writes).toEqual([
      {
        name: "alice",
        address: SENDER_L2,
        addressKind: "aztec-l2",
        tag: "alice",
        verified: true,
        autoAdded: true,
      },
    ])
  })
})

describe("createContactsByL2", () => {
  it("matches only tagged L2 entries by address, case-insensitively", async () => {
    const entries: Contact[] = [
      { name: "eve-l1", address: SENDER_L2, addressKind: "ethereum-l1", tag: "eve" },
      { name: "tagless", address: SENDER_L2 },
      { name: "alice", address: SENDER_L2.toUpperCase(), tag: "alice", addressKind: "aztec-l2" },
    ]
    const contacts = createContactsByL2(contactStoreFake(entries))
    expect(await contacts.findByL2Address(SENDER_L2)).toEqual({ tag: "alice" })
    expect(await contacts.findByL2Address(ACCOUNT_L2)).toBeNull()
  })
})

describe("createRequestStoreWrites", () => {
  it("lands an incoming request in the requests store and applies a decline", async () => {
    const requests = memRequests()
    const receiver = new RequestReceiver(createRequestStoreWrites(requests))
    const announce = {
      kind: "request" as const,
      requestId: "req-1",
      requesterTag: "alice",
      amountAtomic: "5000000",
      decimals: 6,
      token: TOKEN,
      tokenSymbol: "DAI",
      networkId: "aztec-dev",
      note: "lunch",
    }
    expect((await receiver.process({ content: announce })).status).toBe("accepted")
    // Duplicate delivery is a no-op.
    expect((await receiver.process({ content: announce })).status).toBe("duplicate")

    const rows = requests.view.get()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: "req-1",
      contactTag: "alice",
      amount: 5,
      asset: "DAI",
      direction: "incoming",
      status: "pending",
      kind: "contact",
      tokenAddress: TOKEN,
      amountAtomic: "5000000",
      tokenDecimals: 6,
      note: "lunch",
      networkId: "aztec-dev",
    })

    const declined = {
      kind: "request-declined" as const,
      requestId: "req-1",
      networkId: "aztec-dev",
    }
    expect((await receiver.process({ content: declined })).status).toBe("accepted")
    const [row] = requests.view.get()
    expect(row.status).toBe("declined")
  })
})

describe("createRequestSenderPolicy", () => {
  const contacts = (entries: Contact[]) => ({ getEntries: async () => entries })
  const ada: Contact = { name: "Ada", address: SENDER_L2, tag: "ada" }

  it("admits only tagged L2 contacts once they are blocked", async () => {
    const pending: Contact = {
      name: "kai",
      address: "xmtp-handle",
      addressKind: "pending-handshake",
      tag: "kai",
    }
    const policy = createRequestSenderPolicy(contacts([ada, pending]), () => false)
    expect(await policy.admitsRequester("ADA")).toBe(true)
    expect(await policy.admitsRequester("kai")).toBe(false)
    expect(await policy.admitsRequester("mina")).toBe(false)
  })
})

describe("requests from a sender added from a transfer", () => {
  const announce = {
    kind: "request" as const,
    requestId: "req-alice",
    requesterTag: "alice",
    amountAtomic: "5000000",
    decimals: 6,
    token: TOKEN,
    networkId: "aztec-dev",
  }
  const packet = { content: announce, senderXmtpAddresses: ["0xpeer"] }

  /** Contact book, request store and receiver over one storage, after alice sent 0.01 unasked. */
  async function afterTransfer(allowNonContacts: boolean) {
    ContactStorage.resetForTests()
    const storage = memStorage()
    const contacts = ContactStorage.get(storage)
    const requests = memRequests()
    const receiver = new RequestReceiver(
      createRequestStoreWrites(requests),
      undefined,
      { resolveXmtpBinding: async () => "0xpeer" },
      createRequestSenderPolicy(contacts, () => allowNonContacts),
    )
    const txStorage = await freshTxStorage(storage)
    const events = [scannedEvent({ amount: "10000" })]
    const scanner = scannerOver(txStorage, createContactsByL2(contacts), events)
    await scanner.pass(scanContext, { full: true })
    expect(await contacts.findByTag("alice")).toMatchObject({ autoAdded: true })
    /** Whether Activity and the inbox read the stored request as from a non-contact. */
    const listedAsNonContact = async () => {
      const rows = (await contacts.getEntries()).filter(isPaymentContactEntry)
      const request = (await requests.get(announce.requestId))!
      return isFromNonContact(request, approvedContactTags(rows.map(contactRowFromEntry)))
    }
    return { contacts, receiver, listedAsNonContact }
  }

  it("are refused while blocked, and admitted once paying a request saves the sender", async () => {
    const { contacts, receiver, listedAsNonContact } = await afterTransfer(false)
    expect(await receiver.process(packet)).toEqual({
      status: "ignored",
      reason: "sender-not-admitted",
    })

    // The save contactPay makes when the user pays a request from this sender.
    await contacts.addEntry({ name: "alice", address: SENDER_L2, verified: true, tag: "alice" })
    expect(await receiver.process(packet)).toEqual({ status: "accepted", kind: "request" })
    expect(await listedAsNonContact()).toBe(false)
  })

  it("are listed as from a non-contact while allowed", async () => {
    const { receiver, listedAsNonContact } = await afterTransfer(true)
    expect(await receiver.process(packet)).toEqual({ status: "accepted", kind: "request" })
    expect(await listedAsNonContact()).toBe(true)
  })
})

describe("createTagForwardResolver", () => {
  it("narrows the registry union: resolved → l2Address, notFound → null, invalid tag → null", async () => {
    const resolved = createTagForwardResolver(async () => ({
      status: "resolved",
      account: "0x00000000000000000000000000000000000000aa",
      l2Address: SENDER_L2,
      rollupId: "aztec-dev",
      sipaStealthPublicKey: { x: 1n, y: 2n },
      xmtpAddress: "0x00000000000000000000000000000000000000b0",
    }))
    expect(await resolved.resolveL2("alice", "aztec-dev")).toEqual({ l2Address: SENDER_L2 })

    const notFound = createTagForwardResolver(async () => ({ status: "notFound" }))
    expect(await notFound.resolveL2("ghost", "aztec-dev")).toBeNull()

    const invalid = createTagForwardResolver(async () => {
      throw new TagValidationError("bad tag")
    })
    expect(await invalid.resolveL2("BAD!", "aztec-dev")).toBeNull()
  })

  it("rethrows transport failures so the receiver defers", async () => {
    const down = createTagForwardResolver(async () => {
      throw new Error("registry unreachable")
    })
    await expect(down.resolveL2("alice", "aztec-dev")).rejects.toThrow("registry unreachable")
  })
})
