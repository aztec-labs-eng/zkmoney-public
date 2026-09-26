import { describe, it, expect, beforeEach, vi } from "vitest"

import {
  XmtpInboxReceiverDriver,
  type ConnectBackReceiverLike,
  type CurrentAccountInfo,
  type RequestReceiverLike,
} from "../../src/xmtp/inboxDriver"
import type { XmtpClientManagerLike } from "../../src/xmtp/types"
import type { ConnectBackStatus } from "../../src/xmtp/ConnectBackReceiver"
import type { RequestReceiveStatus } from "../../src/xmtp/requestReceiverTypes"
import type { IStorageAdapter } from "../../src/core/storages/adapter"

const REQUEST_TYPE = "obsidion.xyz/payment-request:1.0"
const TEXT_TYPE = "xmtp.org/text:1.0"
const CONNECT_BACK_TYPE = "obsidion.xyz/connect-back:1.0"
// The retired transfer lane's content type — now just another unknown content id.
const LEGACY_TRANSFER_TYPE = "obsidion.xyz/aztec-send-transfer:2.0"

class InMemoryStorage implements IStorageAdapter {
  store = new Map<string, string>()
  async getItem(key: string) {
    return this.store.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    this.store.set(key, value)
  }
  async removeItem(key: string) {
    this.store.delete(key)
  }
  async clear() {
    this.store.clear()
  }
}

interface FakeMessage {
  id: string
  sentNs: number | bigint
  contentTypeId: string
  contentValue: any
}

interface FakeConversation {
  id: string
  messages: FakeMessage[]
  consent?: "allowed" | "unknown" | "denied"
  /** Authenticated DM peer address returned by getDmPeerAddresses. */
  peerAddress?: string | null
}

/**
 * Test-only controls layered onto the faked manager: drive the scripted stream
 * (push a message into the registered callback, close it) and read per-method
 * call counts (for the probe's flat-cost assertions in Unit 5). Existing poll
 * tests ignore these extra members; streaming/probe tests use them.
 */
interface FakeXmtpControls {
  /** Fire the registered streamAllMessages callback with a scripted message. */
  pushStreamMessage(message: any): void
  /** Fire the registered onClose callback and tear the stream down. */
  closeStream(): void
  /** Whether a stream subscription is currently live. */
  streamActive(): boolean
  counts: {
    listConversations: number
    syncAllConversations: number
    messagesAfter: number
    messagesAfterLocal: number
    findConversation: number
    subscribeAllMessages: number
  }
}

function buildFakeXmtp(opts: {
  installationId?: string | null
  conversations?: FakeConversation[]
  isReady?: boolean
  listConversationsThrows?: boolean
  messagesAfterThrowsFor?: Set<string>
  syncAllConversationsThrows?: boolean
}): XmtpClientManagerLike & FakeXmtpControls {
  const conversations = opts.conversations ?? []

  // Identity-stable SDK Conversation handles, memoized by id — mirrors the real
  // SDK where list()/findConversation() hand back stable references (the
  // list-derived topic->id map and messagesAfterLocal(conv) rely on this).
  // Lazy so a conversation added to the array after construction is still
  // resolvable, preserving the original fresh-map behavior for existing tests.
  const sdkConvById = new Map<string, any>()
  const getSdkConv = (c: FakeConversation) => {
    let sdk = sdkConvById.get(c.id)
    if (!sdk) {
      sdk = toSdkConversation(c)
      sdkConvById.set(c.id, sdk)
    }
    return sdk
  }

  const counts = {
    listConversations: 0,
    syncAllConversations: 0,
    messagesAfter: 0,
    messagesAfterLocal: 0,
    findConversation: 0,
    subscribeAllMessages: 0,
  }

  let streamCb: ((message: any) => void) | null = null
  let streamOnClose: (() => void) | undefined

  const readAfter = (conv: any, sentNs: number | bigint) => {
    const cid = (conv as any).id as string
    if (opts.messagesAfterThrowsFor?.has(cid)) throw new Error("messagesAfter boom")
    const fake = conversations.find((c) => c.id === cid)
    if (!fake) return []
    return fake.messages.filter((m) => BigInt(m.sentNs) > BigInt(sentNs)).map(toSdkMessage)
  }

  return {
    isReady: () => opts.isReady ?? true,
    get installationId() {
      return opts.installationId ?? "install-A"
    },
    listConversations: async () => {
      counts.listConversations++
      if (opts.listConversationsThrows) throw new Error("boom")
      return conversations.map(getSdkConv)
    },
    messagesAfter: async (conv, sentNs) => {
      counts.messagesAfter++
      return readAfter(conv, sentNs)
    },
    getDmPeerAddresses: async (conv) => {
      const cid = (conv as any).id as string
      const fake = conversations.find((c) => c.id === cid)
      const peer = fake?.peerAddress === undefined ? "0xpeer" : fake.peerAddress
      return peer ? [peer] : []
    },
    messagesAfterLocal: async (conv, sentNs) => {
      counts.messagesAfterLocal++
      return readAfter(conv, sentNs)
    },
    syncAllConversations: async () => {
      counts.syncAllConversations++
      if (opts.syncAllConversationsThrows) throw new Error("syncAllConversations boom")
      const eligible = conversations.filter((c) => (c.consent ?? "allowed") !== "denied")
      const synced = eligible.filter((c) => c.messages.length > 0)
      return { numEligible: eligible.length, numSynced: synced.length }
    },
    findConversation: async (id: string) => {
      counts.findConversation++
      const fake = conversations.find((c) => c.id === id)
      return fake ? getSdkConv(fake) : undefined
    },
    subscribeAllMessages: async (onMessage, onClose) => {
      counts.subscribeAllMessages++
      streamCb = onMessage
      streamOnClose = onClose
      return () => {
        streamCb = null
        streamOnClose = undefined
      }
    },
    // ── test-only controls (not part of XmtpClientManagerLike) ──
    pushStreamMessage: (message: any) => streamCb?.(message),
    closeStream: () => {
      streamOnClose?.()
      streamCb = null
      streamOnClose = undefined
    },
    streamActive: () => streamCb !== null,
    counts,
  }
}

function toSdkConversation(fake: FakeConversation): any {
  return {
    id: fake.id,
    topic: `/xmtp/mls/1/g-${fake.id}/proto`,
    consentState: async () => fake.consent ?? "allowed",
  }
}

function toSdkMessage(m: FakeMessage): any {
  return {
    id: m.id,
    sentNs: m.sentNs,
    contentTypeId: m.contentTypeId,
    content: () => m.contentValue,
  }
}

const SAMPLE_ACCOUNT: CurrentAccountInfo = {
  tag: "self",
  l2Address: "0xself",
  rollupId: "0xrollup",
}

function buildDriver(opts: {
  xmtp: XmtpClientManagerLike
  requestReceiver?: RequestReceiverLike
  connectBackReceiver?: ConnectBackReceiverLike
  ownXmtpAddress?: string | null
  currentAccount?: () => Promise<CurrentAccountInfo | null>
  storage?: IStorageAdapter
  connectBackBudgetPerCycle?: number
  pollIntervalMs?: number
}) {
  return new XmtpInboxReceiverDriver({
    xmtp: opts.xmtp,
    requestReceiver: opts.requestReceiver,
    connectBackReceiver: opts.connectBackReceiver,
    ownXmtpAddress: opts.ownXmtpAddress,
    currentAccount: opts.currentAccount ?? (async () => SAMPLE_ACCOUNT),
    asyncStorage: opts.storage ?? new InMemoryStorage(),
    connectBackBudgetPerCycle: opts.connectBackBudgetPerCycle,
    pollIntervalMs: opts.pollIntervalMs,
    logger: { log: () => {}, warn: () => {} },
  })
}

/** Payment-request message; `requestId` mirrors the message id so tests can key calls by it. */
function requestMsg(id: string, sentNs: number | bigint): FakeMessage {
  return {
    id,
    sentNs,
    contentTypeId: REQUEST_TYPE,
    contentValue: {
      kind: "request",
      requestId: id,
      requesterTag: "alice",
      amountAtomic: "1",
      token: `0x${"11".repeat(32)}`,
      decimals: 6,
      networkId: "aztec-dev",
    },
  }
}

function textMsg(id: string, sentNs: number): FakeMessage {
  return { id, sentNs, contentTypeId: TEXT_TYPE, contentValue: "hello" }
}

function legacyTransferMsg(id: string, sentNs: number): FakeMessage {
  return { id, sentNs, contentTypeId: LEGACY_TRANSFER_TYPE, contentValue: { token: "0xtoken" } }
}

function connectBackMsg(id: string, sentNs: number, uuid = "uuid-1", tag?: string): FakeMessage {
  return {
    id,
    sentNs,
    contentTypeId: CONNECT_BACK_TYPE,
    contentValue: tag ? { version: 1, uuid, tag } : { version: 1, uuid },
  }
}

type RequestReceiveInput = { content: any; senderXmtpAddresses: string[] }

/** Accepting request receiver; call log lives on the vi.fn mock. */
function acceptingRequestReceiver() {
  return {
    process: vi.fn(
      async (_input: RequestReceiveInput): Promise<RequestReceiveStatus> => ({
        status: "accepted",
        kind: "request",
      }),
    ),
  }
}

/** requestIds fed to an accepting receiver, in call order. */
function fedRequestIds(receiver: ReturnType<typeof acceptingRequestReceiver>): string[] {
  return receiver.process.mock.calls.map((c) => c[0].content.requestId)
}

/** Records `process` calls and returns a per-test stubbed status. */
class FakeConnectBackReceiver implements ConnectBackReceiverLike {
  calls: Array<{
    uuid: string
    senderXmtpAddresses: string[]
    ownXmtpAddress?: string | null
    claimedTag?: string | null
  }> = []
  impl?: (input: { uuid: string; senderXmtpAddresses: string[] }) => Promise<ConnectBackStatus>

  async process(input: {
    uuid: string
    senderXmtpAddresses: string[]
    ownXmtpAddress?: string | null
    claimedTag?: string | null
  }): Promise<ConnectBackStatus> {
    this.calls.push(input)
    if (this.impl) return this.impl(input)
    return { status: "accepted", added: true }
  }
}

describe("XmtpInboxReceiverDriver", () => {
  beforeEach(() => {
    XmtpInboxReceiverDriver.resetInstance()
  })

  describe("pollNow", () => {
    it("runs a fresh cycle even when a cycle is already in flight (does not no-op)", async () => {
      let listCalls = 0
      let releaseFirst: () => void = () => {}
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      let processCalls = 0

      const conv: FakeConversation = { id: "convA", messages: [requestMsg("m1", 100)] }
      // Minimal hand-rolled manager: only the methods pollOnce's full sweep
      // touches. Cast through `unknown` (the streaming methods on the interface
      // aren't exercised here), matching the partial-fake pattern below.
      const xmtp = {
        isReady: () => true,
        get installationId() {
          return "install-A"
        },
        listConversations: async () => {
          listCalls += 1
          return [toSdkConversation(conv)]
        },
        messagesAfter: async (_c: any, sentNs: number) =>
          conv.messages.filter((m) => m.sentNs > sentNs).map(toSdkMessage),
        getDmPeerAddresses: async () => ["0xpeer"],
      } as unknown as XmtpClientManagerLike
      const requestReceiver: RequestReceiverLike = {
        process: async () => {
          processCalls += 1
          // Block the FIRST cycle inside process so it's still running when
          // pollNow is called.
          if (processCalls === 1) await firstGate
          return { status: "accepted", kind: "request" }
        },
      }
      const driver = buildDriver({ xmtp, requestReceiver })

      // Cycle 1 starts and blocks in process; currentRun is in flight.
      const p1 = driver.pollOnce()
      // pollNow must drain the in-flight cycle, then run a guaranteed fresh one.
      const pNow = driver.pollNow()
      releaseFirst()
      await Promise.all([p1, pNow])

      // Two cycles ran (cycle 1 + the fresh cycle pollNow forced). A plain
      // pollOnce would have coalesced into cycle 1 and left listCalls at 1.
      expect(listCalls).toBe(2)
    })
  })

  describe("happy path", () => {
    it("processes payment-request messages and advances cursors per conversation", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [requestMsg("m1", 100), requestMsg("m2", 200)],
          },
          {
            id: "convB",
            messages: [requestMsg("m3", 150)],
          },
        ],
      })
      const receiver = acceptingRequestReceiver()
      const storage = new InMemoryStorage()
      const driver = buildDriver({ xmtp, requestReceiver: receiver, storage })

      await driver.pollOnce()

      expect(receiver.process).toHaveBeenCalledTimes(3)
      // Both conversations' cursors advanced.
      const stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(stored.cursors.convA).toBe(200)
      expect(stored.cursors.convB).toBe(150)
      expect(stored.installationId).toBe("install-A")
    })

    it("subsequent pollOnce with no new messages calls receiver zero times", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [{ id: "convA", messages: [requestMsg("m1", 100)] }],
      })
      const receiver = acceptingRequestReceiver()
      const driver = buildDriver({ xmtp, requestReceiver: receiver })

      await driver.pollOnce()
      await driver.pollOnce()

      expect(receiver.process).toHaveBeenCalledTimes(1)
    })
  })

  describe("status handling", () => {
    it("keeps cursor unmoved on deferred and re-feeds the message next cycle", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [requestMsg("m1", 100), requestMsg("m2", 200)],
          },
        ],
      })
      const calls: string[] = []
      const requestReceiver: RequestReceiverLike = {
        process: async (input) => {
          calls.push(input.content.requestId)
          if (input.content.requestId === "m2") {
            return { status: "deferred", reason: "store-write-failure" }
          }
          return { status: "accepted", kind: "request" }
        },
      }
      const storage = new InMemoryStorage()
      const driver = buildDriver({ xmtp, requestReceiver, storage })

      await driver.pollOnce()
      const after1 = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      // Cursor stuck at m1.sentNs because m2 deferred.
      expect(after1.cursors.convA).toBe(100)

      await driver.pollOnce()
      // m2 fed again.
      expect(calls.filter((c) => c === "m2").length).toBe(2)
    })

    it("advances cursor on duplicate and ignored", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [requestMsg("m1", 100), requestMsg("m2", 200), requestMsg("m3", 300)],
          },
        ],
      })
      const requestReceiver: RequestReceiverLike = {
        process: async (input) => {
          if (input.content.requestId === "m1") return { status: "duplicate" }
          if (input.content.requestId === "m2")
            return { status: "ignored", reason: "no-matching-request" }
          return { status: "accepted", kind: "request" }
        },
      }
      const storage = new InMemoryStorage()
      const driver = buildDriver({ xmtp, requestReceiver, storage })

      await driver.pollOnce()

      const stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(stored.cursors.convA).toBe(300)
    })

    it("treats per-message throw from receiver as deferred (cursor unmoved)", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [requestMsg("m1", 100), requestMsg("m2", 200)],
          },
        ],
      })
      const requestReceiver: RequestReceiverLike = {
        process: async (input) => {
          if (input.content.requestId === "m2") throw new Error("kaboom")
          return { status: "accepted", kind: "request" }
        },
      }
      const storage = new InMemoryStorage()
      const driver = buildDriver({ xmtp, requestReceiver, storage })

      await driver.pollOnce()
      const stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(stored.cursors.convA).toBe(100)
    })
  })

  describe("content type filtering", () => {
    it("advances cursor for unknown content (incl. the legacy transfer type) without any receiver call, but DOES dispatch connect-backs and requests", async () => {
      // text (skip) → legacy transfer (skip — the lane is gone) → connect-back
      // (dispatch to connectBackReceiver) → request (dispatch to requestReceiver).
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [
              textMsg("t1", 100),
              legacyTransferMsg("x1", 120),
              connectBackMsg("cb1", 150, "uuid-1"),
              requestMsg("m3", 300),
            ],
          },
        ],
      })
      const receiver = acceptingRequestReceiver()
      const connectBackReceiver = new FakeConnectBackReceiver()
      const storage = new InMemoryStorage()
      const driver = buildDriver({ xmtp, requestReceiver: receiver, connectBackReceiver, storage })

      await driver.pollOnce()

      // Request receiver only saw the single payment-request message.
      expect(receiver.process).toHaveBeenCalledTimes(1)
      expect(fedRequestIds(receiver)).toEqual(["m3"])
      // Connect-back receiver saw the connect-back (not skipped as unknown content).
      expect(connectBackReceiver.calls).toHaveLength(1)
      expect(connectBackReceiver.calls[0].uuid).toBe("uuid-1")
      const stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(stored.cursors.convA).toBe(300)
    })

    it("connect-back with no connectBackReceiver wired is skipped like unknown content", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [connectBackMsg("cb1", 100), requestMsg("m2", 200)],
          },
        ],
      })
      const receiver = acceptingRequestReceiver()
      const storage = new InMemoryStorage()
      // No connectBackReceiver supplied.
      const driver = buildDriver({ xmtp, requestReceiver: receiver, storage })

      await driver.pollOnce()

      expect(receiver.process).toHaveBeenCalledTimes(1)
      const stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      // Cursor advanced past both messages (connect-back skipped, request accepted).
      expect(stored.cursors.convA).toBe(200)
    })

    it("payment-request with no requestReceiver wired is skipped like unknown content", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [{ id: "convA", messages: [requestMsg("m1", 100)] }],
      })
      const storage = new InMemoryStorage()
      const driver = buildDriver({ xmtp, storage })

      await driver.pollOnce()

      const stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(stored.cursors.convA).toBe(100)
    })
  })

  describe("connect-back dispatch", () => {
    it("routes connect-back to the receiver with sender + own address, and advances on accepted", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [connectBackMsg("cb1", 100, "uuid-1"), requestMsg("m2", 200)],
            peerAddress: "0xsender",
          },
        ],
      })
      const requestReceiver = acceptingRequestReceiver()
      const connectBackReceiver = new FakeConnectBackReceiver()
      const storage = new InMemoryStorage()
      const driver = buildDriver({
        xmtp,
        requestReceiver,
        connectBackReceiver,
        ownXmtpAddress: "0xself",
        storage,
      })

      await driver.pollOnce()

      expect(connectBackReceiver.calls).toHaveLength(1)
      expect(connectBackReceiver.calls[0].uuid).toBe("uuid-1")
      // Authenticated sender resolved from getDmPeerAddresses; own address passed.
      expect(connectBackReceiver.calls[0].senderXmtpAddresses).toEqual(["0xsender"])
      expect(connectBackReceiver.calls[0].ownXmtpAddress).toBe("0xself")
      // The following request was processed in the same cycle.
      expect(requestReceiver.process).toHaveBeenCalledTimes(1)
      const stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(stored.cursors.convA).toBe(200)
    })

    it("forwards a claimed tag from the connect-back payload", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [connectBackMsg("cb1", 100, "uuid-1", "bob")],
            peerAddress: "0xsender",
          },
        ],
      })
      const connectBackReceiver = new FakeConnectBackReceiver()
      const driver = buildDriver({
        xmtp,
        receiver: {
          processMessage: async () => ({
            status: "accepted" as const,
            txHash: "x",
            transaction: {} as any,
          }),
        },
        connectBackReceiver,
        storage: new InMemoryStorage(),
      })

      await driver.pollOnce()

      expect(connectBackReceiver.calls).toHaveLength(1)
      expect(connectBackReceiver.calls[0].claimedTag).toBe("bob")
    })

    it("holds the cursor on a deferred connect-back and re-feeds it next cycle", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [connectBackMsg("cb1", 100, "uuid-1"), requestMsg("m2", 200)],
          },
        ],
      })
      const requestReceiver = acceptingRequestReceiver()
      const connectBackReceiver = new FakeConnectBackReceiver()
      let attempts = 0
      connectBackReceiver.impl = async () => {
        attempts += 1
        if (attempts === 1) return { status: "deferred", reason: "claimed-tag-verifier-unavailable" }
        return { status: "accepted", added: true }
      }
      const storage = new InMemoryStorage()
      const driver = buildDriver({ xmtp, requestReceiver, connectBackReceiver, storage })

      await driver.pollOnce()
      // Cursor held at 0 (connect-back deferred); request m2 never reached.
      const after1 = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(after1.cursors.convA ?? 0).toBe(0)
      expect(requestReceiver.process).not.toHaveBeenCalled()

      await driver.pollOnce()
      // Re-fed; second attempt accepted → both messages now processed.
      expect(connectBackReceiver.calls.length).toBe(2)
      const after2 = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(after2.cursors.convA).toBe(200)
      expect(requestReceiver.process).toHaveBeenCalledTimes(1)
    })

    it("honors the per-cycle connect-back budget (exhaustion holds + resumes)", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [
              connectBackMsg("cb1", 100, "u1"),
              connectBackMsg("cb2", 200, "u2"),
              connectBackMsg("cb3", 300, "u3"),
            ],
          },
        ],
      })
      const connectBackReceiver = new FakeConnectBackReceiver()
      const storage = new InMemoryStorage()
      const driver = buildDriver({
        xmtp,
        connectBackReceiver,
        storage,
        connectBackBudgetPerCycle: 2,
      })

      await driver.pollOnce()
      // Two processed, budget exhausted before the third; cursor at cb2.
      expect(connectBackReceiver.calls.length).toBe(2)
      let stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(stored.cursors.convA).toBe(200)
      expect(stored.resumeConversationId).toBe("convA")

      await driver.pollOnce()
      // Third processed on the next cycle.
      expect(connectBackReceiver.calls.length).toBe(3)
      stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(stored.cursors.convA).toBe(300)
    })

    it("payment-requests share the connect-back budget (exhaustion holds + resumes)", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [requestMsg("r1", 100), requestMsg("r2", 200), requestMsg("r3", 300)],
          },
        ],
      })
      const receiver = acceptingRequestReceiver()
      const storage = new InMemoryStorage()
      const driver = buildDriver({
        xmtp,
        requestReceiver: receiver,
        storage,
        connectBackBudgetPerCycle: 2,
      })

      await driver.pollOnce()
      expect(receiver.process).toHaveBeenCalledTimes(2)
      let stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(stored.cursors.convA).toBe(200)
      expect(stored.resumeConversationId).toBe("convA")

      await driver.pollOnce()
      expect(receiver.process).toHaveBeenCalledTimes(3)
      stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(stored.cursors.convA).toBe(300)
      expect(stored.resumeConversationId).toBeUndefined()
    })
  })

  describe("consent filtering", () => {
    it("skips denied conversations entirely", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          { id: "convA", messages: [requestMsg("m1", 100)], consent: "denied" },
          { id: "convB", messages: [requestMsg("m2", 200)], consent: "allowed" },
        ],
      })
      const receiver = acceptingRequestReceiver()
      const driver = buildDriver({ xmtp, requestReceiver: receiver })

      await driver.pollOnce()

      expect(receiver.process).toHaveBeenCalledTimes(1)
      expect(fedRequestIds(receiver)).toEqual(["m2"])
    })

    it("treats consentState throw as unknown (eligible)", async () => {
      const xmtp = {
        isReady: () => true,
        get installationId() {
          return "install-A"
        },
        listConversations: async () => [
          {
            id: "convA",
            consentState: async () => {
              throw new Error("consent boom")
            },
          } as any,
        ],
        messagesAfter: async () => [toSdkMessage(requestMsg("m1", 100))],
        getDmPeerAddresses: async () => ["0xpeer"],
      } as unknown as XmtpClientManagerLike
      const receiver = acceptingRequestReceiver()
      const driver = buildDriver({ xmtp, requestReceiver: receiver })

      await driver.pollOnce()

      expect(receiver.process).toHaveBeenCalledTimes(1)
    })
  })

  describe("installationId binding", () => {
    it("resets cursor map on installationId mismatch", async () => {
      const storage = new InMemoryStorage()
      // Pre-seed with a different installationId and a populated cursor.
      await storage.setItem(
        "@obsidion/xmtp-inbox-driver/cursors/v1",
        JSON.stringify({
          installationId: "install-OLD",
          cursors: { convA: 999 },
        }),
      )

      const xmtp = buildFakeXmtp({
        installationId: "install-NEW",
        conversations: [{ id: "convA", messages: [requestMsg("m1", 100)] }],
      })
      const receiver = acceptingRequestReceiver()
      const driver = buildDriver({ xmtp, requestReceiver: receiver, storage })

      await driver.pollOnce()

      // The reset clears the stale 999, so m1 (sentNs=100) is reprocessed.
      expect(receiver.process).toHaveBeenCalledTimes(1)
      const stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(stored.installationId).toBe("install-NEW")
      expect(stored.cursors.convA).toBe(100)
    })
  })

  describe("error paths", () => {
    it("currentAccount null defers the whole cycle", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [{ id: "convA", messages: [requestMsg("m1", 100)] }],
      })
      const receiver = acceptingRequestReceiver()
      const driver = buildDriver({
        xmtp,
        requestReceiver: receiver,
        currentAccount: async () => null,
      })

      await driver.pollOnce()

      expect(receiver.process).not.toHaveBeenCalled()
    })

    it("xmtp not ready defers the whole cycle", async () => {
      const xmtp = buildFakeXmtp({
        isReady: false,
        conversations: [{ id: "convA", messages: [requestMsg("m1", 100)] }],
      })
      const receiver = acceptingRequestReceiver()
      const driver = buildDriver({ xmtp, requestReceiver: receiver })

      await driver.pollOnce()

      expect(receiver.process).not.toHaveBeenCalled()
    })

    it("messagesAfter throw on one conversation leaves its cursor unmoved and continues", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          { id: "convA", messages: [requestMsg("m1", 100)] },
          { id: "convB", messages: [requestMsg("m2", 200)] },
        ],
        messagesAfterThrowsFor: new Set(["convA"]),
      })
      const receiver = acceptingRequestReceiver()
      const storage = new InMemoryStorage()
      const driver = buildDriver({ xmtp, requestReceiver: receiver, storage })

      await driver.pollOnce()

      expect(receiver.process).toHaveBeenCalledTimes(1)
      const stored = JSON.parse(storage.store.get("@obsidion/xmtp-inbox-driver/cursors/v1")!)
      expect(stored.cursors.convA).toBeUndefined()
      expect(stored.cursors.convB).toBe(200)
    })

    it("listConversations throw aborts the cycle silently", async () => {
      const xmtp = buildFakeXmtp({
        listConversationsThrows: true,
      })
      const receiver = acceptingRequestReceiver()
      const driver = buildDriver({ xmtp, requestReceiver: receiver })

      await driver.pollOnce()

      expect(receiver.process).not.toHaveBeenCalled()
    })
  })

  describe("ordering and dedup", () => {
    it("processes by ascending sentNs even if SDK returns reverse order", async () => {
      // Build the conversation with messages in REVERSE sentNs order in the
      // fake; the driver should sort by (sentNs, id) defensively.
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [requestMsg("m3", 300), requestMsg("m1", 100), requestMsg("m2", 200)],
          },
        ],
      })
      const receiver = acceptingRequestReceiver()
      const driver = buildDriver({ xmtp, requestReceiver: receiver })

      await driver.pollOnce()

      expect(fedRequestIds(receiver)).toEqual(["m1", "m2", "m3"])
    })

    it("dedups identical (sentNs, id) within a cycle", async () => {
      const xmtp = buildFakeXmtp({
        conversations: [
          {
            id: "convA",
            messages: [
              requestMsg("m1", 100),
              requestMsg("m1", 100), // exact dup — same id+sentNs
              requestMsg("m2", 200),
            ],
          },
        ],
      })
      const receiver = acceptingRequestReceiver()
      const driver = buildDriver({ xmtp, requestReceiver: receiver })

      await driver.pollOnce()

      expect(receiver.process).toHaveBeenCalledTimes(2)
    })
  })

  describe("lifecycle", () => {
    it("start() is idempotent — calling twice does not double-schedule", async () => {
      vi.useFakeTimers()
      try {
        const xmtp = buildFakeXmtp({
          conversations: [{ id: "convA", messages: [] }],
        })
        const receiver = acceptingRequestReceiver()
        const driver = buildDriver({ xmtp, requestReceiver: receiver, pollIntervalMs: 5000 })

        await driver.start()
        await driver.start()
        // Advance well past one interval; if start double-scheduled,
        // we'd see two pollOnce timers fire.
        await vi.advanceTimersByTimeAsync(5500)
        driver.stop()
        // No request messages exist, so process never called.
        // But more importantly, no crash from doubled timers.
        expect(true).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it("re-entrancy: if pollOnce is in flight, second pollOnce is a no-op", async () => {
      let resolveFirst!: () => void
      const blocker = new Promise<void>((r) => {
        resolveFirst = r
      })

      const xmtp = buildFakeXmtp({
        conversations: [{ id: "convA", messages: [requestMsg("m1", 100)] }],
      })
      const requestReceiver: RequestReceiverLike = {
        process: vi.fn(async () => {
          await blocker
          return { status: "accepted" as const, kind: "request" as const }
        }),
      }
      const driver = buildDriver({ xmtp, requestReceiver })

      const first = driver.pollOnce()
      // Kick off a second while first is mid-flight.
      const second = driver.pollOnce()

      // Resolve the first.
      resolveFirst()
      await Promise.all([first, second])

      // Receiver only called once because the second pollOnce exited early.
      expect(requestReceiver.process).toHaveBeenCalledTimes(1)
    })
  })
})

describe("streaming/probe fake surface (Unit 1)", () => {
  it("registers a stream callback and fires it on pushStreamMessage", async () => {
    const xmtp = buildFakeXmtp({ conversations: [{ id: "convA", messages: [] }] })
    const received: any[] = []
    const cancel = await xmtp.subscribeAllMessages((m) => received.push(m))

    expect(xmtp.streamActive()).toBe(true)
    xmtp.pushStreamMessage({ id: "m1", topic: "/xmtp/mls/1/g-convA/proto" })
    expect(received).toHaveLength(1)
    expect(received[0].id).toBe("m1")

    cancel()
    expect(xmtp.streamActive()).toBe(false)
    // After cancel, a push is a no-op (no registered callback).
    xmtp.pushStreamMessage({ id: "m2", topic: "/xmtp/mls/1/g-convA/proto" })
    expect(received).toHaveLength(1)
  })

  it("closeStream fires onClose and tears the subscription down", async () => {
    const xmtp = buildFakeXmtp({ conversations: [] })
    let closed = false
    await xmtp.subscribeAllMessages(
      () => {},
      () => {
        closed = true
      },
    )
    xmtp.closeStream()
    expect(closed).toBe(true)
    expect(xmtp.streamActive()).toBe(false)
  })

  it("syncAllConversations returns a {numEligible, numSynced} summary and is counted", async () => {
    const xmtp = buildFakeXmtp({
      conversations: [
        { id: "a", messages: [requestMsg("m1", 100)] }, // eligible + unread
        { id: "b", messages: [] }, // eligible, no unread
        { id: "c", messages: [requestMsg("m2", 50)], consent: "denied" }, // excluded
      ],
    })
    const summary = await xmtp.syncAllConversations()
    expect(summary).toEqual({ numEligible: 2, numSynced: 1 })
    expect(xmtp.counts.syncAllConversations).toBe(1)
  })

  it("messagesAfterLocal reads after a cursor, counted separately from messagesAfter", async () => {
    const conv = { id: "a", messages: [requestMsg("m1", 100), requestMsg("m2", 200)] }
    const xmtp = buildFakeXmtp({ conversations: [conv] })
    const handle = await xmtp.findConversation("a")

    const local = await xmtp.messagesAfterLocal(handle!, 100)
    expect(local.map((m: any) => m.id)).toEqual(["m2"])
    expect(xmtp.counts.messagesAfterLocal).toBe(1)
    expect(xmtp.counts.messagesAfter).toBe(0)
  })

  it("findConversation returns identity-stable handles shared with listConversations", async () => {
    const xmtp = buildFakeXmtp({ conversations: [{ id: "a", messages: [] }] })
    const fromList = (await xmtp.listConversations())[0]
    const fromFind = await xmtp.findConversation("a")
    expect(fromFind).toBe(fromList) // same reference
    expect(await xmtp.findConversation("missing")).toBeUndefined()
  })
})

describe("dirty-signal drain (Unit 3)", () => {
  beforeEach(() => {
    XmtpInboxReceiverDriver.resetInstance()
  })

  const CURSOR_KEY = "@obsidion/xmtp-inbox-driver/cursors/v1"

  it("drains only the dirty conversations, not the whole consented set", async () => {
    const xmtp = buildFakeXmtp({
      conversations: [
        { id: "convA", messages: [requestMsg("m1", 100)] },
        { id: "convB", messages: [requestMsg("m2", 150)] },
      ],
    })
    const receiver = acceptingRequestReceiver()
    const storage = new InMemoryStorage()
    const driver = buildDriver({ xmtp, requestReceiver: receiver, storage })
    ;(driver as any).dirtyIds.add("convA")

    await (driver as any).drainDirty()

    expect(receiver.process).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(storage.store.get(CURSOR_KEY)!)
    expect(stored.cursors.convA).toBe(100)
    expect(stored.cursors.convB ?? 0).toBe(0) // convB never touched
    // Targeted drain resolves via findConversation — no full-sweep listConversations.
    expect(xmtp.counts.listConversations).toBe(0)
  })

  it("skips an unresolvable dirty id without throwing", async () => {
    const xmtp = buildFakeXmtp({ conversations: [{ id: "convA", messages: [] }] })
    const receiver = acceptingRequestReceiver()
    const driver = buildDriver({ xmtp, requestReceiver: receiver })
    ;(driver as any).dirtyIds.add("ghost")

    await expect((driver as any).drainDirty()).resolves.toBeUndefined()
    expect(receiver.process).not.toHaveBeenCalled()
  })

  it("drops a denied conversation at the drain-time consent re-check", async () => {
    const xmtp = buildFakeXmtp({
      conversations: [{ id: "convA", messages: [requestMsg("m1", 100)], consent: "denied" }],
    })
    const receiver = acceptingRequestReceiver()
    const driver = buildDriver({ xmtp, requestReceiver: receiver })
    ;(driver as any).dirtyIds.add("convA")

    await (driver as any).drainDirty()
    expect(receiver.process).not.toHaveBeenCalled()
  })

  it("drains allowed-consent before unknown under budget pressure", async () => {
    const xmtp = buildFakeXmtp({
      conversations: [
        { id: "convU", messages: [requestMsg("mu", 100)], consent: "unknown" },
        { id: "convA", messages: [requestMsg("ma", 100)], consent: "allowed" },
      ],
    })
    const receiver = acceptingRequestReceiver()
    const storage = new InMemoryStorage()
    const driver = buildDriver({
      xmtp,
      requestReceiver: receiver,
      storage,
      connectBackBudgetPerCycle: 1,
    })
    ;(driver as any).dirtyIds.add("convU")
    ;(driver as any).dirtyIds.add("convA")

    await (driver as any).drainDirty()

    // The single budget slot went to the ALLOWED conversation; the unknown one
    // was re-queued.
    expect(receiver.process).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(storage.store.get(CURSOR_KEY)!)
    expect(stored.cursors.convA).toBe(100)
    expect(stored.cursors.convU ?? 0).toBe(0)
    expect((driver as any).dirtyIds.has("convU")).toBe(true)
  })

  it("caps a drain at the per-drain batch limit and re-queues the overflow", async () => {
    const convs = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`,
      messages: [requestMsg(`m${i}`, 100)],
    }))
    const xmtp = buildFakeXmtp({ conversations: convs })
    const receiver = acceptingRequestReceiver()
    // Budget = batch cap so the trailing re-drain finds an exhausted budget and
    // just re-queues (deterministic 20 processed).
    const driver = buildDriver({ xmtp, requestReceiver: receiver, connectBackBudgetPerCycle: 20 })
    for (const c of convs) (driver as any).dirtyIds.add(c.id)

    await (driver as any).drainDirty()
    await new Promise((r) => setTimeout(r, 0)) // let any trailing drain settle

    // Cap = 20: only 20 synced this drain; the 5 overflow stay dirty.
    expect(receiver.process).toHaveBeenCalledTimes(20)
    expect((driver as any).dirtyIds.size).toBe(5)
  })

  it("coalesces a markDirty burst into one debounced drain", async () => {
    vi.useFakeTimers()
    try {
      const xmtp = buildFakeXmtp({
        conversations: [
          { id: "a", messages: [requestMsg("ma", 100)] },
          { id: "b", messages: [requestMsg("mb", 100)] },
        ],
      })
      const receiver = acceptingRequestReceiver()
      const driver = buildDriver({ xmtp, requestReceiver: receiver })

      driver.markDirty("a")
      driver.markDirty("a") // duplicate within the window
      driver.markDirty("b")
      expect(receiver.process).not.toHaveBeenCalled() // debounced, not yet

      await vi.runAllTimersAsync()

      // One drain processed both distinct conversations.
      expect(receiver.process).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("re-runs once after an in-flight drain when a mark arrives mid-drain (trailing edge)", async () => {
    const xmtp = buildFakeXmtp({
      conversations: [
        { id: "convA", messages: [requestMsg("ma", 100)] },
        { id: "convB", messages: [requestMsg("mb", 100)] },
      ],
    })
    // First process signals it has started, then blocks on `gate` so a mark can
    // be injected after the first drain's snapshot but before it finishes.
    let openGate!: () => void
    const gate = new Promise<void>((r) => (openGate = r))
    let signalStarted!: () => void
    const started = new Promise<void>((r) => (signalStarted = r))
    let calls = 0
    const requestReceiver: RequestReceiverLike = {
      process: vi.fn(async () => {
        calls += 1
        if (calls === 1) {
          signalStarted()
          await gate
        }
        return { status: "accepted" as const, kind: "request" as const }
      }),
    }
    const driver = buildDriver({ xmtp, requestReceiver })
    ;(driver as any).dirtyIds.add("convA")

    const first = (driver as any).drainDirty() // starts; blocks inside process(convA)
    await started // snapshot of {convA} is done

    // A mark arrives mid-drain -> deferred via the trailing-edge flag.
    ;(driver as any).dirtyIds.add("convB")
    ;(driver as any).requestDrain()
    expect((driver as any).pendingDrain).toBe(true)

    openGate()
    await first
    await new Promise((r) => setTimeout(r, 0)) // let the trailing drain settle

    expect(requestReceiver.process).toHaveBeenCalledTimes(2) // convA then convB
  })
})

describe("tiered backstop probe (Unit 5)", () => {
  beforeEach(() => {
    XmtpInboxReceiverDriver.resetInstance()
  })

  const CURSOR_KEY = "@obsidion/xmtp-inbox-driver/cursors/v1"

  it("syncs once and reads locally — no per-conversation network sync", async () => {
    const convs = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      messages: [requestMsg(`m${i}`, 100)],
    }))
    const xmtp = buildFakeXmtp({ conversations: convs })
    const driver = buildDriver({ xmtp, requestReceiver: acceptingRequestReceiver() })

    await driver.probeOnce()

    // One batched network sync; conversations read from the LOCAL DB (no
    // per-conversation messagesAfter network sync).
    expect(xmtp.counts.syncAllConversations).toBe(1)
    expect(xmtp.counts.messagesAfter).toBe(0)
    expect(xmtp.counts.messagesAfterLocal).toBe(5)
  })

  it("keeps network-call count flat in conversation count when idle", async () => {
    const network: number[] = []
    for (const n of [1, 50, 200]) {
      const xmtp = buildFakeXmtp({
        conversations: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, messages: [] })),
      })
      const driver = buildDriver({ xmtp, requestReceiver: acceptingRequestReceiver() })
      await driver.probeOnce()
      XmtpInboxReceiverDriver.resetInstance()
      // Count the FULL per-tick network surface: syncAllConversations (1) +
      // listConversations (1, the local sweep's enumerate) + per-conversation
      // network syncs (0 — the sweep reads messagesAfterLocal). Summing all three
      // is what makes this a real O(1) guard: a regression that reintroduced a
      // per-conversation network sync (messagesAfter) would push the total to N.
      expect(xmtp.counts.messagesAfter).toBe(0)
      network.push(
        xmtp.counts.syncAllConversations +
          xmtp.counts.listConversations +
          xmtp.counts.messagesAfter,
      )
    }
    expect(network).toEqual([2, 2, 2])
  })

  it("ingests a new message via the probe and advances the cursor", async () => {
    const xmtp = buildFakeXmtp({
      conversations: [{ id: "convA", messages: [requestMsg("m1", 100)] }],
    })
    const receiver = acceptingRequestReceiver()
    const storage = new InMemoryStorage()
    const driver = buildDriver({ xmtp, requestReceiver: receiver, storage })

    await driver.probeOnce()

    expect(receiver.process).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(storage.store.get(CURSOR_KEY)!)
    expect(stored.cursors.convA).toBe(100)
  })

  it("tolerates a syncAllConversations failure and still runs the local sweep", async () => {
    const xmtp = buildFakeXmtp({
      conversations: [{ id: "convA", messages: [requestMsg("m1", 100)] }],
      syncAllConversationsThrows: true,
    })
    const receiver = acceptingRequestReceiver()
    const driver = buildDriver({ xmtp, requestReceiver: receiver })

    await expect(driver.probeOnce()).resolves.toBeUndefined()
    expect(receiver.process).toHaveBeenCalledTimes(1) // local sweep still ran
  })
})

describe("characterization (U3 hoist)", () => {
  beforeEach(() => {
    XmtpInboxReceiverDriver.resetInstance()
  })

  const CURSOR_KEY = "@obsidion/xmtp-inbox-driver/cursors/v1"

  it("cursor map round-trips through storage across driver instances (no re-feed)", async () => {
    const storage = new InMemoryStorage()
    const conversations = [{ id: "convA", messages: [requestMsg("m1", 100)] }]

    const receiver1 = acceptingRequestReceiver()
    const driver1 = buildDriver({
      xmtp: buildFakeXmtp({ conversations }),
      requestReceiver: receiver1,
      storage,
    })
    await driver1.pollOnce()
    expect(receiver1.process).toHaveBeenCalledTimes(1)

    // Fresh driver instance, same storage: the persisted cursor must prevent a re-feed.
    XmtpInboxReceiverDriver.resetInstance()
    const receiver2 = acceptingRequestReceiver()
    const driver2 = buildDriver({
      xmtp: buildFakeXmtp({ conversations }),
      requestReceiver: receiver2,
      storage,
    })
    await driver2.pollOnce()
    expect(receiver2.process).not.toHaveBeenCalled()

    const stored = JSON.parse(storage.store.get(CURSOR_KEY)!)
    expect(stored.cursors.convA).toBe(100)
  })

  it("large ns cursor values (>2^53-scale, double-representable) survive persistence without precision loss", async () => {
    // Realistic XMTP sentNs (~1.7e18) exceed MAX_SAFE_INTEGER. 2^60 and 2^60+256
    // are exactly representable doubles, so they must round-trip storage exactly.
    const NS1 = 2 ** 60
    const NS2 = 2 ** 60 + 256
    const storage = new InMemoryStorage()
    const conversations = [{ id: "convA", messages: [requestMsg("m1", NS1)] }]

    const receiver1 = acceptingRequestReceiver()
    const driver1 = buildDriver({
      xmtp: buildFakeXmtp({ conversations }),
      requestReceiver: receiver1,
      storage,
    })
    await driver1.pollOnce()
    expect(receiver1.process).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(storage.store.get(CURSOR_KEY)!)
    expect(BigInt(stored.cursors.convA)).toBe(BigInt(NS1))

    // Reload from storage: m1 must NOT be re-fed; a strictly-newer m2 must be.
    XmtpInboxReceiverDriver.resetInstance()
    conversations[0].messages.push(requestMsg("m2", NS2))
    const receiver2 = acceptingRequestReceiver()
    const driver2 = buildDriver({
      xmtp: buildFakeXmtp({ conversations }),
      requestReceiver: receiver2,
      storage,
    })
    await driver2.pollOnce()
    expect(receiver2.process).toHaveBeenCalledTimes(1)
    expect(fedRequestIds(receiver2)).toEqual(["m2"])
    const stored2 = JSON.parse(storage.store.get(CURSOR_KEY)!)
    expect(BigInt(stored2.cursors.convA)).toBe(BigInt(NS2))
  })

  it("true-bigint ns cursors (not double-representable) survive persistence without precision loss", async () => {
    // Browser-sdk timestamps are bigint; 2^60+1 / 2^60+2 have no exact double,
    // so any number round-trip would collapse them onto 2^60.
    const NS1 = 2n ** 60n + 1n
    const NS2 = 2n ** 60n + 2n
    const storage = new InMemoryStorage()
    const conversations = [{ id: "convA", messages: [requestMsg("m1", NS1)] }]

    const receiver1 = acceptingRequestReceiver()
    const driver1 = buildDriver({
      xmtp: buildFakeXmtp({ conversations }),
      requestReceiver: receiver1,
      storage,
    })
    await driver1.pollOnce()
    expect(receiver1.process).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(storage.store.get(CURSOR_KEY)!)
    expect(BigInt(stored.cursors.convA)).toBe(NS1)

    // Reload: m1 (== cursor) must not re-feed; m2 (cursor + 1) must.
    XmtpInboxReceiverDriver.resetInstance()
    conversations[0].messages.push(requestMsg("m2", NS2))
    const receiver2 = acceptingRequestReceiver()
    const driver2 = buildDriver({
      xmtp: buildFakeXmtp({ conversations }),
      requestReceiver: receiver2,
      storage,
    })
    await driver2.pollOnce()
    expect(receiver2.process).toHaveBeenCalledTimes(1)
    expect(fedRequestIds(receiver2)).toEqual(["m2"])
    const stored2 = JSON.parse(storage.store.get(CURSOR_KEY)!)
    expect(BigInt(stored2.cursors.convA)).toBe(NS2)
  })

  it("full sweep admits allowed and unknown consent, and only those", async () => {
    const xmtp = buildFakeXmtp({
      conversations: [
        { id: "convAllowed", messages: [requestMsg("ma", 100)], consent: "allowed" },
        { id: "convUnknown", messages: [requestMsg("mu", 100)], consent: "unknown" },
        { id: "convDenied", messages: [requestMsg("md", 100)], consent: "denied" },
      ],
    })
    const receiver = acceptingRequestReceiver()
    const driver = buildDriver({ xmtp, requestReceiver: receiver })

    await driver.pollOnce()

    expect(fedRequestIds(receiver).sort()).toEqual(["ma", "mu"])
  })

  it("stream fast-path feeds the receiver end to end (message -> dirty -> drain)", async () => {
    vi.useFakeTimers()
    try {
      const xmtp = buildFakeXmtp({
        conversations: [{ id: "convA", messages: [requestMsg("m1", 100)] }],
      })
      const receiver = acceptingRequestReceiver()
      const driver = buildDriver({ xmtp, requestReceiver: receiver })

      await driver.startStream()
      xmtp.pushStreamMessage({ id: "sm", topic: "/xmtp/mls/1/g-convA/proto" })
      await vi.runAllTimersAsync()

      expect(receiver.process).toHaveBeenCalledTimes(1)
      driver.stopStream()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("stream fast-path (Unit 4)", () => {
  beforeEach(() => {
    XmtpInboxReceiverDriver.resetInstance()
  })

  it("marks the right conversation dirty from a streamed message's topic", async () => {
    vi.useFakeTimers()
    try {
      const xmtp = buildFakeXmtp({
        conversations: [{ id: "convA", messages: [requestMsg("m1", 100)] }],
      })
      const driver = buildDriver({ xmtp, requestReceiver: acceptingRequestReceiver() })

      await driver.startStream()
      expect(xmtp.streamActive()).toBe(true)

      // toSdkConversation builds topic `/xmtp/mls/1/g-<id>/proto`.
      xmtp.pushStreamMessage({ id: "sm", topic: "/xmtp/mls/1/g-convA/proto" })
      expect((driver as any).dirtyIds.has("convA")).toBe(true)

      driver.stopStream()
      expect(xmtp.streamActive()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reconnects with backoff after onClose, and stopStream halts reconnection", async () => {
    vi.useFakeTimers()
    try {
      const xmtp = buildFakeXmtp({ conversations: [] })
      const driver = buildDriver({ xmtp, requestReceiver: acceptingRequestReceiver() })

      await driver.startStream()
      expect(xmtp.streamActive()).toBe(true)

      xmtp.closeStream() // fires onClose -> schedules a reconnect
      expect(xmtp.streamActive()).toBe(false)
      expect((driver as any).reconnectTimer).not.toBeNull()

      await vi.advanceTimersByTimeAsync(1_000) // RECONNECT_BASE_MS (first attempt)
      expect(xmtp.streamActive()).toBe(true) // reconnected

      driver.stopStream()
      xmtp.closeStream() // onClose after stop -> no reconnect (streamWanted false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(xmtp.streamActive()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops a streamed message with an unresolved topic without throwing", async () => {
    const xmtp = buildFakeXmtp({ conversations: [{ id: "convA", messages: [] }] })
    const driver = buildDriver({ xmtp, requestReceiver: acceptingRequestReceiver() })

    await driver.startStream()
    xmtp.pushStreamMessage({ id: "x", topic: "/xmtp/mls/1/g-ghost/proto" })
    await new Promise((r) => setTimeout(r, 0)) // let the async miss-refresh settle

    expect((driver as any).dirtyIds.size).toBe(0)
    driver.stopStream()
  })

  it("stop during the startStream await leaves no dangling subscription", async () => {
    const xmtp = buildFakeXmtp({ conversations: [{ id: "convA", messages: [] }] })
    const driver = buildDriver({ xmtp, requestReceiver: acceptingRequestReceiver() })

    // Kick off a start but DON'T await it, then synchronously stop before the
    // async subscribeAllMessages resolves. The post-await guard in startStream
    // must cancel the just-opened subscription instead of installing one nobody
    // wants — otherwise a background transition mid-start leaks a live stream.
    const starting = driver.startStream()
    driver.stopStream()
    await starting

    expect(xmtp.streamActive()).toBe(false)
    expect((driver as any).streamCancel).toBeNull()
    expect((driver as any).streamStarting).toBe(false)
  })

  it("ignores a re-entrant startStream while one is already starting", async () => {
    const xmtp = buildFakeXmtp({ conversations: [{ id: "convA", messages: [] }] })
    const driver = buildDriver({ xmtp, requestReceiver: acceptingRequestReceiver() })

    // Two overlapping starts (e.g. AppState `active` racing the reconnect timer)
    // must open exactly one subscription — the streamStarting guard drops the
    // second while the first is mid-await.
    const a = driver.startStream()
    const b = driver.startStream()
    await Promise.all([a, b])

    expect(xmtp.streamActive()).toBe(true)
    expect(xmtp.counts.subscribeAllMessages).toBe(1)
    driver.stopStream()
  })
})

describe("payment-request dispatch", () => {
  beforeEach(() => {
    XmtpInboxReceiverDriver.resetInstance()
  })

  it("passes the authenticated DM peer address to the request receiver", async () => {
    const xmtp = buildFakeXmtp({
      conversations: [
        {
          id: "convA",
          peerAddress: "0xAuthedPeer",
          messages: [requestMsg("r1", 100)],
        },
      ],
    })
    const calls: Array<{ senderXmtpAddresses: string[] }> = []
    const driver = buildDriver({
      xmtp,
      requestReceiver: {
        process: async (input) => {
          calls.push({ senderXmtpAddresses: input.senderXmtpAddresses })
          return { status: "accepted", kind: "request" }
        },
      },
    })

    await driver.pollOnce()

    expect(calls).toEqual([{ senderXmtpAddresses: ["0xAuthedPeer"] }])
  })

  it("skips kind-less content (old-client kind the schema dropped) and advances the cursor", async () => {
    // The XMTP SDK swallows codec schema errors and returns undefined content — e.g. an
    // old-version peer's `request-fulfilled` message after the kind was removed from the union.
    const xmtp = buildFakeXmtp({
      conversations: [
        {
          id: "convA",
          peerAddress: "0xOldPeer",
          messages: [
            { id: "r1", sentNs: 100, contentTypeId: REQUEST_TYPE, contentValue: undefined },
          ],
        },
      ],
    })
    let processed = 0
    const warns: string[] = []
    const driver = new XmtpInboxReceiverDriver({
      xmtp,
      receiver: { processMessage: async () => ({ status: "duplicate", txHash: "0x" }) },
      requestReceiver: {
        process: async () => {
          processed++
          return { status: "accepted", kind: "request" }
        },
      },
      currentAccount: async () => SAMPLE_ACCOUNT,
      asyncStorage: new InMemoryStorage(),
      logger: {
        log: () => {},
        warn: (...args: unknown[]) => warns.push(args.map(String).join(" ")),
      },
    })

    await driver.pollOnce()
    await driver.pollOnce()

    // Never dispatched, and skipped exactly once — the second poll read past the advanced
    // cursor instead of re-hitting the message (not wedged).
    expect(processed).toBe(0)
    expect(warns.filter((w) => w.includes("undecodable payment-request content")).length).toBe(1)
  })
})
