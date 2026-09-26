import { describe, expect, it } from "vitest"
import type { Address, Hash } from "viem"

import type { SIPADepositRecord } from "../../src/core/services/deposits/SIPADepositStore"
import {
  reconcileSipaRequestFulfillments,
  requestLinkedSipaAddresses,
  sipaDepositFulfillsRequest,
} from "../../src/core/paymentRequest/sipaRequestFulfillment"
import type { IStorageAdapter } from "../../src/core/storages/adapter"
import { RequestStorage, type PaymentRequest } from "../../src/core/storages/RequestStorage"

const SIPA = "0xAbCdEf0123456789abcdef0123456789abcdef01" as Address
const OTHER = "0x0000000000000000000000000000000000000001" as Address
const CLAIM = "0x" + "ab".repeat(32)
const SWEEP = ("0x" + "cd".repeat(32)) as Hash
const NET = "1000000000000000000"

function memoryAdapter(): IStorageAdapter {
  const map = new Map<string, string>()
  return {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
    clear: async () => map.clear(),
  }
}

function pendingLink(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    id: "req-1",
    contactTag: "",
    amount: 1,
    asset: "DAI",
    direction: "outgoing",
    status: "pending",
    createdAt: 0,
    kind: "link",
    amountAtomic: NET,
    tokenDecimals: 18,
    sipaAddress: SIPA,
    ...overrides,
  }
}

function deposit(overrides: Partial<SIPADepositRecord> = {}): SIPADepositRecord {
  return {
    sipaAddress: SIPA,
    recipientL2Address: "0x1",
    messageSecret: "0x2",
    recipientHash: "0x3",
    recoveryAddress: "0x4",
    l1ChainId: 31337,
    amount: "1",
    tokenSymbol: "DAI",
    phase: "claimed",
    startTime: 1,
    netAmount: NET,
    claimTxHash: CLAIM,
    sweepTxHash: SWEEP,
    ...overrides,
  }
}

describe("sipaDepositFulfillsRequest", () => {
  it("matches a claimed deposit to a pending outgoing row by sipaAddress", () => {
    expect(sipaDepositFulfillsRequest(deposit(), pendingLink())).toBe(true)
  })

  it("matches sipaAddress case-insensitively", () => {
    expect(
      sipaDepositFulfillsRequest(deposit(), pendingLink({ sipaAddress: SIPA.toLowerCase() })),
    ).toBe(true)
  })

  it("rejects broadcast and sweeping — mint already published this SIPA", () => {
    expect(sipaDepositFulfillsRequest(deposit({ phase: "broadcast" }), pendingLink())).toBe(false)
    expect(sipaDepositFulfillsRequest(deposit({ phase: "sweeping" }), pendingLink())).toBe(false)
  })

  it("rejects an underpayment", () => {
    expect(
      sipaDepositFulfillsRequest(deposit({ netAmount: "500000000000000000" }), pendingLink()),
    ).toBe(false)
  })

  it("fulfils an any-amount link on the first claimed deposit", () => {
    expect(
      sipaDepositFulfillsRequest(deposit({ netAmount: "1" }), pendingLink({ amountAtomic: "0" })),
    ).toBe(true)
    expect(
      sipaDepositFulfillsRequest(
        deposit({ netAmount: "1" }),
        pendingLink({ amountAtomic: undefined }),
      ),
    ).toBe(true)
  })

  it("ignores unknown SIPAs, incoming rows, and already-fulfilled rows", () => {
    expect(sipaDepositFulfillsRequest(deposit({ sipaAddress: OTHER }), pendingLink())).toBe(false)
    expect(sipaDepositFulfillsRequest(deposit(), pendingLink({ direction: "incoming" }))).toBe(
      false,
    )
    expect(sipaDepositFulfillsRequest(deposit(), pendingLink({ status: "fulfilled" }))).toBe(false)
    expect(sipaDepositFulfillsRequest(deposit(), pendingLink({ sipaAddress: undefined }))).toBe(
      false,
    )
  })
})

describe("requestLinkedSipaAddresses", () => {
  it("collects lowercased addresses, skipping rows without one", () => {
    expect(
      requestLinkedSipaAddresses([
        pendingLink(),
        pendingLink({ sipaAddress: undefined }),
        pendingLink({ sipaAddress: OTHER.toUpperCase() as Address }),
      ]),
    ).toEqual(new Set([SIPA.toLowerCase(), OTHER.toLowerCase()]))
  })
})

describe("reconcileSipaRequestFulfillments", () => {
  it("flips a matching pending row and stamps claimTxHash", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingLink())
    await reconcileSipaRequestFulfillments(store, [deposit()])
    const row = await store.findById("req-1")
    expect(row?.status).toBe("fulfilled")
    expect(row?.fulfillmentTxHash).toBe(CLAIM)
  })

  it("falls back to sweepTxHash when the claim hash is missing", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingLink())
    await reconcileSipaRequestFulfillments(store, [deposit({ claimTxHash: undefined })])
    expect((await store.findById("req-1"))?.fulfillmentTxHash).toBe(SWEEP)
  })

  it("leaves the row pending on broadcast, sweeping, underpay, or unknown SIPA", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingLink({ id: "broadcast" }))
    await store.add(pendingLink({ id: "sweeping" }))
    await store.add(pendingLink({ id: "underpay" }))
    await store.add(pendingLink({ id: "unknown" }))
    await reconcileSipaRequestFulfillments(store, [
      deposit({ phase: "broadcast" }),
      deposit({ phase: "sweeping" }),
      deposit({ netAmount: "1" }),
      deposit({ sipaAddress: OTHER }),
    ])
    for (const id of ["broadcast", "sweeping", "underpay", "unknown"]) {
      expect((await store.findById(id))?.status).toBe("pending")
    }
  })

  it("flips a cancelled row — fulfilled always wins", async () => {
    const store = new RequestStorage(memoryAdapter())
    await store.add(pendingLink({ status: "cancelled" }))
    await reconcileSipaRequestFulfillments(store, [deposit()])
    expect((await store.findById("req-1"))?.status).toBe("fulfilled")
  })
})
