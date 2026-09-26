/**
 * Verified-transfer → request-row reconciliation: a pending outgoing request flips to `fulfilled`
 * when a verified incoming transfer carrying its id (from the on-chain `Transfer.meta`) lands and
 * satisfies it. Contact rows also require the verified sender to be that contact.
 */
import { describe, expect, it } from "vitest"

import type { IStorageAdapter } from "../../src/core/storages/adapter"
import { RequestStorage, type PaymentRequest } from "../../src/core/storages/RequestStorage"
import type { TokenTransaction } from "../../src/types/transactions"
import {
  reconcileRequestFulfillments,
  startRequestFulfillmentReconciler,
} from "../../src/xmtp/requestFulfillmentReconciler"

function memoryAdapter(): IStorageAdapter {
  const map = new Map<string, string>()
  return {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
    clear: async () => map.clear(),
  }
}

const TOKEN = "0x" + "aa".repeat(32)
const TX = "0x" + "ab".repeat(32)
const REQ = "0x" + "0c".repeat(32)

function pendingRow(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    id: REQ,
    contactTag: "alice",
    amount: 1,
    asset: "DAI",
    direction: "outgoing",
    status: "pending",
    createdAt: 0,
    kind: "contact",
    amountAtomic: "1000000",
    tokenDecimals: 6,
    tokenAddress: TOKEN,
    ...overrides,
  }
}

function verifiedTx(
  overrides: Partial<TokenTransaction["token"]> = {},
  tx: Partial<TokenTransaction> = {},
): TokenTransaction {
  return {
    action: "receive",
    status: "success",
    timestamp: 0,
    txHash: TX,
    from: "alice",
    requestId: REQ,
    ...tx,
    token: {
      address: TOKEN,
      name: "DAI",
      symbol: "DAI",
      decimals: 6,
      logo: "",
      amount: 1,
      price: 1,
      ...overrides,
    },
  }
}

describe("reconcileRequestFulfillments", () => {
  it("flips a pending row whose id the verified transfer carries", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingRow())
    await reconcileRequestFulfillments(store, verifiedTx())
    const row = await store.findById(REQ)
    expect(row?.status).toBe("fulfilled")
    expect(row?.fulfillmentTxHash).toBe(TX)
  })

  it("matches the request id case-insensitively", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingRow())
    await reconcileRequestFulfillments(store, verifiedTx({}, { requestId: REQ.toUpperCase() }))
    expect((await store.findById(REQ))?.status).toBe("fulfilled")
  })

  it("leaves the row pending when the transfer amount is short", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingRow())
    await reconcileRequestFulfillments(store, verifiedTx({ amount: 0.5 }))
    expect((await store.findById(REQ))?.status).toBe("pending")
  })

  it("leaves the row pending on token mismatch", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingRow())
    await reconcileRequestFulfillments(store, verifiedTx({ address: "0x" + "bb".repeat(32) }))
    expect((await store.findById(REQ))?.status).toBe("pending")
  })

  it("requires the verified sender to be the contact on a contact row", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingRow())
    await reconcileRequestFulfillments(store, verifiedTx({}, { from: "mallory" }))
    expect((await store.findById(REQ))?.status).toBe("pending")
  })

  it("accepts any verified payer on a link row", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingRow({ kind: "link", contactTag: "" }))
    await reconcileRequestFulfillments(store, verifiedTx({}, { from: "stranger" }))
    expect((await store.findById(REQ))?.status).toBe("fulfilled")
  })

  it("ignores transfers without a request id, incoming rows, and unrelated ids", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingRow({ id: "incoming", direction: "incoming" }))
    await store.add(pendingRow({ id: "0x" + "0d".repeat(32) }))
    await store.add(pendingRow())
    await reconcileRequestFulfillments(store, verifiedTx({}, { requestId: undefined }))
    await reconcileRequestFulfillments(store, verifiedTx({}, { requestId: "0x" + "0e".repeat(32) }))
    for (const id of ["incoming", "0x" + "0d".repeat(32), REQ]) {
      expect((await store.findById(id))?.status).toBe("pending")
    }
  })

  it("does not regress an already-terminal row", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingRow({ status: "cancelled" }))
    await reconcileRequestFulfillments(store, verifiedTx())
    expect((await store.findById(REQ))?.status).toBe("cancelled")
  })
})

describe("startRequestFulfillmentReconciler reverse join", () => {
  const receivesWith = (tx: TokenTransaction | null) => ({
    findReceivesByRequestId: async (id: string) =>
      tx && tx.requestId?.toLowerCase() === id.toLowerCase() ? [tx] : [],
  })
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it("flips a pending row already fulfilled by a stored receive at start", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingRow())
    const stop = startRequestFulfillmentReconciler(store, receivesWith(verifiedTx()))
    await settle()
    const row = await store.findById(REQ)
    expect(row?.status).toBe("fulfilled")
    expect(row?.fulfillmentTxHash).toBe(TX)
    stop()
  })

  it("flips a request row added after its receive was scanned", async () => {
    const store = new RequestStorage(memoryAdapter())
    const stop = startRequestFulfillmentReconciler(store, receivesWith(verifiedTx()))
    await settle()
    // The request lands late (storage replay / multi-device sync) — the store-change sweep joins it.
    await store.add(pendingRow())
    await settle()
    expect((await store.findById(REQ))?.status).toBe("fulfilled")
    stop()
  })

  it("keeps the contact gate on the reverse join", async () => {
    const store = new RequestStorage(memoryAdapter())
    const stop = startRequestFulfillmentReconciler(
      store,
      receivesWith(verifiedTx({}, { from: "mallory" })),
    )
    await settle()
    await store.add(pendingRow())
    await settle()
    expect((await store.findById(REQ))?.status).toBe("pending")
    stop()
  })

  it("checks later receives when an earlier matching payment was insufficient", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingRow())
    const short = verifiedTx({}, { txHash: "0xshort", amountAtomic: "1" })
    const sufficient = verifiedTx({}, { amountAtomic: "1000000" })
    const stop = startRequestFulfillmentReconciler(store, {
      findReceivesByRequestId: async () => [short, sufficient],
    })
    await expect.poll(async () => (await store.findById(REQ))?.status).toBe("fulfilled")
    expect((await store.findById(REQ))?.fulfillmentTxHash).toBe(TX)
    stop()
  })

  it("does nothing without a receives reader", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingRow())
    const stop = startRequestFulfillmentReconciler(store)
    await settle()
    expect((await store.findById(REQ))?.status).toBe("pending")
    stop()
  })
})
