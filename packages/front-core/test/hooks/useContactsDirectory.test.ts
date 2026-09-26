import { describe, expect, it, vi, beforeEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { Contact } from "../../src/core"

const mockEntries: { current: Contact[] } = { current: [] }
const mockListeners = new Set<() => void>()

vi.mock("../../src/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core")>()
  return {
    ...actual,
    ContactStorage: {
      get: () => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        getEntries: () => Promise.resolve(mockEntries.current),
        onChange: (listener: () => void) => {
          mockListeners.add(listener)
          return () => mockListeners.delete(listener)
        },
      }),
    },
  }
})

import {
  contactRowFromEntry,
  isPaymentContactEntry,
  useContactsDirectory,
} from "../../src/hooks/useContactsDirectory"

const L2_ADDRESS = "0x2cb424c9829710e462cbfe9b65e168be6d88eda507dd3e8a1b38b56f4df3cb12"
const L1_ADDRESS = "0xAbCdEf0123456789aBcDeF0123456789aBcDeF01"

describe("isPaymentContactEntry", () => {
  it("keeps legacy Aztec tag contacts in payment contact lists", () => {
    expect(isPaymentContactEntry({ name: "Theo", address: L2_ADDRESS, tag: "theo" })).toBe(true)
  })

  it("keeps L1 wallet contacts in payment contact lists", () => {
    expect(
      isPaymentContactEntry({
        name: "Rainbow",
        address: L1_ADDRESS,
        addressKind: "ethereum-l1",
        l1Wallet: { provider: "rainbow", provenance: "deposit-attested" },
      }),
    ).toBe(true)
  })

  it("filters out a zero-address (mint) L1 contact", () => {
    expect(
      isPaymentContactEntry({
        name: "External Wallet",
        address: "0x0000000000000000000000000000000000000000",
        addressKind: "ethereum-l1",
        l1Wallet: { provider: "unknown", provenance: "deposit-attested" },
      }),
    ).toBe(false)
  })

  it("filters out a tombstoned (deleted) L1 wallet contact", () => {
    expect(
      isPaymentContactEntry({
        name: "Rainbow",
        address: L1_ADDRESS,
        addressKind: "ethereum-l1",
        l1Wallet: { provider: "rainbow", provenance: "deposit-attested", deletedAt: 1750000000000 },
      }),
    ).toBe(false)
  })

  it("filters out a tagless L2 contact", () => {
    expect(isPaymentContactEntry({ name: "NoTag", address: L2_ADDRESS })).toBe(false)
  })
})

describe("contactRowFromEntry", () => {
  it("maps L1 wallet contacts with address metadata", () => {
    expect(
      contactRowFromEntry({
        name: "Rainbow",
        address: L1_ADDRESS,
        addressKind: "ethereum-l1",
        l1Wallet: { provider: "rainbow", provenance: "deposit-attested" },
      }),
    ).toEqual({
      id: "l1:rainbow:" + L1_ADDRESS.toLowerCase(),
      name: "Rainbow",
      tag: "0xAbCd...eF01",
      address: L1_ADDRESS,
      addressKind: "ethereum-l1",
      provider: "rainbow",
      provenance: "deposit-attested",
    })
  })

  it("same Ethereum address under two providers produces two distinct ContactRow IDs", () => {
    const rainbowRow = contactRowFromEntry({
      name: "Rainbow",
      address: L1_ADDRESS,
      addressKind: "ethereum-l1",
      l1Wallet: { provider: "rainbow", provenance: "deposit-attested" },
    })
    const metamaskRow = contactRowFromEntry({
      name: "MetaMask",
      address: L1_ADDRESS,
      addressKind: "ethereum-l1",
      l1Wallet: { provider: "metamask", provenance: "deposit-attested" },
    })

    expect(rainbowRow.id).toBe("l1:rainbow:" + L1_ADDRESS.toLowerCase())
    expect(metamaskRow.id).toBe("l1:metamask:" + L1_ADDRESS.toLowerCase())
    expect(rainbowRow.id).not.toBe(metamaskRow.id)
  })

  it("L1 wallet contact missing provider falls back to 'unknown' in the ID", () => {
    const row = contactRowFromEntry({
      name: "Mystery",
      address: L1_ADDRESS,
      addressKind: "ethereum-l1",
    })
    expect(row.id).toBe("l1:unknown:" + L1_ADDRESS.toLowerCase())
  })
})

describe("useContactsDirectory", () => {
  beforeEach(() => {
    mockEntries.current = []
    mockListeners.clear()
  })

  it("picks up a contact written by a background writer", async () => {
    const { result } = renderHook(() => useContactsDirectory())
    await waitFor(() => expect(result.current.contacts).toHaveLength(0))

    mockEntries.current = [{ name: "Theo", address: L2_ADDRESS, tag: "theo" }]
    act(() => mockListeners.forEach((listener) => listener()))

    await waitFor(() => expect(result.current.contacts[0]?.tag).toBe("theo"))
  })

  it("loads directory rows and filters out zero-address, tombstoned, and tagless entries", async () => {
    mockEntries.current = [
      { name: "Theo", address: L2_ADDRESS, tag: "theo" },
      { name: "NoTag", address: L2_ADDRESS },
      {
        name: "External Wallet",
        address: "0x0000000000000000000000000000000000000000",
        addressKind: "ethereum-l1",
        l1Wallet: { provider: "unknown", provenance: "deposit-attested" },
      },
      {
        name: "Deleted",
        address: L1_ADDRESS,
        addressKind: "ethereum-l1",
        l1Wallet: { provider: "rainbow", provenance: "deposit-attested", deletedAt: 1 },
      },
    ]

    const { result } = renderHook(() => useContactsDirectory())
    await waitFor(() => expect(result.current.contacts).toHaveLength(1))
    expect(result.current.contacts[0].tag).toBe("theo")
  })

  it("lookupByAddress finds L2 rows case-insensitively and excludes L1 rows", async () => {
    mockEntries.current = [
      { name: "Theo", address: L2_ADDRESS, tag: "theo" },
      {
        name: "Rainbow",
        address: L1_ADDRESS,
        addressKind: "ethereum-l1",
        l1Wallet: { provider: "rainbow", provenance: "deposit-attested" },
      },
    ]

    const { result } = renderHook(() => useContactsDirectory())
    await waitFor(() => expect(result.current.contacts).toHaveLength(2))

    expect(result.current.lookupByAddress(L2_ADDRESS.toUpperCase().replace("0X", "0x"))?.tag).toBe(
      "theo",
    )
    expect(result.current.lookupByAddress(L1_ADDRESS)).toBeUndefined()
  })

  it("lookup matches by id or tag", async () => {
    mockEntries.current = [{ name: "Theo", address: L2_ADDRESS, tag: "theo" }]

    const { result } = renderHook(() => useContactsDirectory())
    await waitFor(() => expect(result.current.contacts).toHaveLength(1))

    expect(result.current.lookup("theo")?.address).toBe(L2_ADDRESS)
    expect(result.current.lookup("missing")).toBeUndefined()
  })
})
