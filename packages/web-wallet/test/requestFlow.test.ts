import { describe, expect, it, vi } from "vitest"
import { RequestStorage, type IStorageAdapter, type PaymentRequest } from "@obsidion/front-core"
import {
  announceOutgoingRequest,
  declineIncomingRequest,
  markRequestPaidLocally,
  newOutgoingRequest,
} from "../src/features/contacts/requestFlow"

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

const TOKEN = { address: "0x" + "1".repeat(64), symbol: "DAI", decimals: 9 }

function incomingRow(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    id: "req-1",
    contactTag: "alice",
    amount: 25,
    asset: "DAI",
    direction: "incoming",
    status: "pending",
    createdAt: Date.now(),
    kind: "contact",
    networkId: "testnet",
    ...overrides,
  }
}

describe("newOutgoingRequest", () => {
  it("mints a pending outgoing contact row with exact base units", () => {
    const row = newOutgoingRequest("alice", "25.50", 9)
    expect(row).not.toBeNull()
    expect(row).toMatchObject({
      contactTag: "alice",
      amount: 25.5,
      asset: "DAI",
      direction: "outgoing",
      status: "pending",
      kind: "contact",
      amountAtomic: "25500000000",
      tokenDecimals: 9,
    })
    expect(row!.id).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("keeps a trimmed note and drops a blank one", () => {
    expect(newOutgoingRequest("alice", "1", 9, "  dinner ")!.note).toBe("dinner")
    expect(newOutgoingRequest("alice", "1", 9, "   ")!.note).toBeUndefined()
    expect(newOutgoingRequest("alice", "1", 9)!.note).toBeUndefined()
  })

  it("rejects non-positive and unparseable amounts", () => {
    expect(newOutgoingRequest("alice", "0", 9)).toBeNull()
    expect(newOutgoingRequest("alice", "-3", 9)).toBeNull()
    expect(newOutgoingRequest("alice", "nope", 9)).toBeNull()
    expect(newOutgoingRequest("alice", "", 9)).toBeNull()
  })

  it("rejects sub-cent amounts and keeps exact base units for cents", () => {
    expect(newOutgoingRequest("alice", "0.0000001", 18)).toBeNull()
    expect(newOutgoingRequest("alice", "0.01", 18)!.amountAtomic).toBe("10000000000000000")
  })
})

describe("announceOutgoingRequest", () => {
  const row = { ...incomingRow(), direction: "outgoing" as const, amountAtomic: "25000000000" }

  it("announces over XMTP with the resolved address and requester identity", async () => {
    const announce = vi.fn().mockResolvedValue({ status: "sent", messageId: "m1" })
    await announceOutgoingRequest(row, {
      broadcaster: { announce },
      resolveXmtpAddress: async () => "0xabc",
      requesterTag: "bob",
      networkId: "testnet",
      token: TOKEN,
    })
    expect(announce).toHaveBeenCalledWith({
      recipientXmtpAddress: "0xabc",
      requestId: row.id,
      requesterTag: "bob",
      amountAtomic: "25000000000",
      token: TOKEN,
      networkId: "testnet",
      note: undefined,
      expiresAt: undefined,
    })
  })

  it("skips silently when the contact has no XMTP binding", async () => {
    const announce = vi.fn()
    await announceOutgoingRequest(row, {
      broadcaster: { announce },
      resolveXmtpAddress: async () => null,
      requesterTag: "bob",
      networkId: "testnet",
      token: TOKEN,
    })
    expect(announce).not.toHaveBeenCalled()
  })

  it("never throws — a resolve failure is swallowed (the local row is authoritative)", async () => {
    await expect(
      announceOutgoingRequest(row, {
        broadcaster: { announce: vi.fn() },
        resolveXmtpAddress: async () => {
          throw new Error("registry down")
        },
        requesterTag: "bob",
        networkId: "testnet",
        token: TOKEN,
      }),
    ).resolves.toBeUndefined()
  })
})

describe("declineIncomingRequest", () => {
  it("flips a pending incoming row to declined and signals the requester", async () => {
    const store = new RequestStorage(memStorage())
    await store.add(incomingRow())
    const signalDeclined = vi.fn().mockResolvedValue({ status: "sent", messageId: "m1" })
    const applied = await declineIncomingRequest("req-1", {
      store,
      broadcaster: { signalDeclined },
      resolveXmtpAddress: async () => "0xabc",
      networkId: "fallback-net",
    })
    expect(applied).toBe(true)
    expect((await store.findById("req-1"))!.status).toBe("declined")
    expect(signalDeclined).toHaveBeenCalledWith({
      recipientXmtpAddress: "0xabc",
      requestId: "req-1",
      networkId: "testnet",
    })
  })

  it("never regresses a fulfilled row (monotonic guard) and sends no signal", async () => {
    const store = new RequestStorage(memStorage())
    await store.add(incomingRow({ status: "fulfilled", fulfillmentTxHash: "0xdead" }))
    const signalDeclined = vi.fn()
    const applied = await declineIncomingRequest("req-1", {
      store,
      broadcaster: { signalDeclined },
      resolveXmtpAddress: async () => "0xabc",
      networkId: "testnet",
    })
    expect(applied).toBe(false)
    expect((await store.findById("req-1"))!.status).toBe("fulfilled")
    expect(signalDeclined).not.toHaveBeenCalled()
  })

  it("re-declining an already-declined row is a no-op", async () => {
    const store = new RequestStorage(memStorage())
    await store.add(incomingRow({ status: "declined" }))
    const signalDeclined = vi.fn()
    const applied = await declineIncomingRequest("req-1", {
      store,
      broadcaster: { signalDeclined },
      resolveXmtpAddress: async () => "0xabc",
      networkId: "testnet",
    })
    expect(applied).toBe(false)
    expect(signalDeclined).not.toHaveBeenCalled()
  })

  it("still declines locally when the XMTP sender is absent or the signal fails", async () => {
    const store = new RequestStorage(memStorage())
    await store.add(incomingRow())
    const applied = await declineIncomingRequest("req-1", {
      store,
      broadcaster: null,
      resolveXmtpAddress: async () => "0xabc",
      networkId: "testnet",
    })
    expect(applied).toBe(true)
    expect((await store.findById("req-1"))!.status).toBe("declined")
  })
})

describe("markRequestPaidLocally", () => {
  const TX = "0x" + "ab".repeat(32)

  it("flips a pending row to fulfilled with the tx hash", async () => {
    const store = new RequestStorage(memStorage())
    await store.add(incomingRow())
    expect(await markRequestPaidLocally("req-1", TX, store)).toBe(true)
    const row = (await store.findById("req-1"))!
    expect(row.status).toBe("fulfilled")
    expect(row.fulfillmentTxHash).toBe(TX)
  })

  it("fulfilled overrides a declined row — a real on-chain payment is authoritative", async () => {
    const store = new RequestStorage(memStorage())
    await store.add(incomingRow({ status: "declined" }))
    expect(await markRequestPaidLocally("req-1", TX, store)).toBe(true)
    expect((await store.findById("req-1"))!.status).toBe("fulfilled")
  })

  it("is a no-op without a local row (a link request has none on the payer's device)", async () => {
    const store = new RequestStorage(memStorage())
    expect(await markRequestPaidLocally("0x" + "0a".repeat(32), TX, store)).toBe(false)
    expect(await store.list()).toEqual([])
  })
})
