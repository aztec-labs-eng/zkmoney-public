/**
 * U10 — web inbox adapters + chain-native ingest. Pure-module tests: the scanner and receivers run
 * against fakes for the event source / registry, and against the real web store adapters over
 * in-memory storage.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  RequestReceiver,
  RequestStorage,
  TagValidationError,
  TransactionStorage,
  TransferEventScanner,
  XmtpInboxReceiverDriver,
  type Contact,
  type IStorageAdapter,
  type InboxConversation,
  type InboxMessage,
  type ScannedTransferEvent,
  type XmtpClientManagerLike,
  createTagForwardResolver,
} from "@obsidion/front-core"
import { createContactsByL2, createRequestStoreWrites } from "../src/platform/xmtp/adapters"

const TX_HASH = `0x${"ab".repeat(32)}`
const SENDER_L2 = `0x${"11".repeat(32)}`
const ACCOUNT_L2 = `0x${"22".repeat(32)}`
const TOKEN = `0x${"33".repeat(32)}`
const REQUEST_TYPE_ID = "obsidion.xyz/payment-request:1.0"

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

/** Fresh TransactionStorage over in-memory storage, pre-seeded to skip the legacy migration. */
async function freshTxStorage(storage: IStorageAdapter): Promise<TransactionStorage> {
  ;(TransactionStorage as unknown as { instance: TransactionStorage | null }).instance = null
  await storage.setItem("obsidion_transactions", "[]")
  return TransactionStorage.get(storage)
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
  txStorage: TransactionStorage,
  contacts: ReturnType<typeof createContactsByL2>,
  events: ScannedTransferEvent[],
  storage: IStorageAdapter,
): TransferEventScanner {
  return new TransferEventScanner({
    source: { headBlock: async () => 10, listIncoming: async () => events },
    storage,
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

/** Fake client port: stream never fires; messages come back only via cursor reads. */
function fakeClient(messages: InboxMessage[]): XmtpClientManagerLike {
  const conv: InboxConversation = {
    id: "conv-1",
    topic: "conv-1",
    consentState: async () => "allowed",
  }
  const after = async (_c: InboxConversation, sentNs: number | bigint) =>
    messages.filter((m) => BigInt(m.sentNs) > BigInt(sentNs))
  return {
    isReady: () => true,
    installationId: "inst-1",
    listConversations: async () => [conv],
    messagesAfter: after,
    messagesAfterLocal: after,
    syncAllConversations: async () => ({ numEligible: 1, numSynced: 1 }),
    findConversation: async (id) => (id === "conv-1" ? conv : undefined),
    subscribeAllMessages: async () => () => {},
    getDmPeerAddresses: async () => [],
  }
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

beforeEach(() => {
  XmtpInboxReceiverDriver.resetInstance()
})

describe("web chain-native transfer ingest", () => {
  it("ingests a scanned transfer through the real web adapters", async () => {
    const storage = memStorage()
    const txStorage = await freshTxStorage(storage)
    const contacts = contactStoreFake([])
    const scanner = scannerOver(txStorage, createContactsByL2(contacts), [scannedEvent()], storage)
    await scanner.start(scanContext)
    scanner.stop()

    const row = await txStorage.findByTxHash(TX_HASH)
    expect(row).not.toBeNull()
    expect(row!.to).toBe("bob")
    // Unknown sender attributes by the registry-verified meta tag and auto-adds to the contact book.
    expect(row!.from).toBe("alice")
    expect(row!.senderL2Address).toBe(SENDER_L2)
    expect(contacts.writes).toEqual([
      { name: "alice", address: SENDER_L2, addressKind: "aztec-l2", tag: "alice", verified: true },
    ])
  })

  it("re-scanning the same event is idempotent (one transaction write)", async () => {
    const storage = memStorage()
    const txStorage = await freshTxStorage(storage)
    const scanner = scannerOver(
      txStorage,
      createContactsByL2(contactStoreFake([])),
      [scannedEvent()],
      storage,
    )
    await scanner.start(scanContext)
    await scanner.tickNow()
    scanner.stop()
    const rows = JSON.parse((await storage.getItem("obsidion_transactions"))!) as unknown[]
    expect(rows).toHaveLength(1)
  })
})

describe("createContactsByL2", () => {
  it("registerL2 auto-adds via the idempotent merge path", async () => {
    const fake = contactStoreFake([])
    await createContactsByL2(fake).registerL2!({ tag: "alice", l2Address: SENDER_L2 })
    expect(fake.writes).toEqual([
      { name: "alice", address: SENDER_L2, addressKind: "aztec-l2", tag: "alice", verified: true },
    ])
  })

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

  it("attributes the transfer row by contact tag when a match exists", async () => {
    const storage = memStorage()
    const txStorage = await freshTxStorage(storage)
    const entries: Contact[] = [
      { name: "ally", address: SENDER_L2, tag: "ally", addressKind: "aztec-l2" },
    ]
    const scanner = scannerOver(
      txStorage,
      createContactsByL2(contactStoreFake(entries)),
      [scannedEvent()],
      storage,
    )
    await scanner.start(scanContext)
    scanner.stop()
    expect((await txStorage.findByTxHash(TX_HASH))!.from).toBe("ally")
  })
})

describe("createRequestStoreWrites", () => {
  it("lands an incoming request in RequestStorage and applies status flips", async () => {
    const requests = new RequestStorage(memStorage())
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

    const rows = await requests.list()
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
    const [row] = await requests.list()
    expect(row.status).toBe("declined")
  })

  it("payment-request messages route through the driver into RequestStorage", async () => {
    const storage = memStorage()
    const requests = new RequestStorage(storage)
    const requestMessage: InboxMessage = {
      id: "r1",
      sentNs: 2_000n,
      contentTypeId: REQUEST_TYPE_ID,
      content: () => ({
        kind: "request",
        requestId: "req-2",
        requesterTag: "alice",
        amountAtomic: "0",
        decimals: 6,
        token: TOKEN,
        networkId: "aztec-dev",
      }),
      topic: "conv-1",
    }
    const driver = XmtpInboxReceiverDriver.getOrCreate({
      xmtp: fakeClient([requestMessage]),
      requestReceiver: new RequestReceiver(createRequestStoreWrites(requests)),
      currentAccount: async () => currentAccount,
      asyncStorage: storage,
    })
    await driver.pollOnce()
    expect(await requests.findById("req-2")).toMatchObject({ id: "req-2", contactTag: "alice" })
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
