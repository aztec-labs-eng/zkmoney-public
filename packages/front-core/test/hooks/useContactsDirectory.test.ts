import { describe, expect, it, vi, beforeEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { Contact } from "../../src/core"

const mockEntries: { current: Contact[] } = { current: [] }
/** Reads left to reject. */
const mockFailures = { current: 0 }
/** Replaces the read when set. */
const mockRead: { current?: () => Promise<Contact[]> } = {}
const mockListeners = new Set<() => void>()

vi.mock("../../src/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core")>()
  return {
    ...actual,
    ContactStorage: {
      get: () => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        getEntries: () =>
          mockRead.current?.() ??
          (mockFailures.current-- > 0
            ? Promise.reject(new Error("read failed"))
            : Promise.resolve(mockEntries.current)),
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
  it("carries the autoAdded flag of a sender added from a transfer", () => {
    const entry = { name: "jo", address: `0x${"0a".repeat(32)}`, tag: "jo" }
    expect(contactRowFromEntry({ ...entry, autoAdded: true }).autoAdded).toBe(true)
    expect("autoAdded" in contactRowFromEntry(entry)).toBe(false)
  })

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
    mockFailures.current = 0
    mockRead.current = undefined
    mockListeners.clear()
  })

  it("reports hydrated only once the first read lands", async () => {
    const { result } = renderHook(() => useContactsDirectory())
    expect(result.current.hydrated).toBe(false)
    await waitFor(() => expect(result.current.hydrated).toBe(true))
  })

  it("reports a failed first read, then retries until a read lands", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      mockFailures.current = 2
      mockEntries.current = [{ name: "Theo", address: L2_ADDRESS, tag: "theo" }]
      const { result } = renderHook(() => useContactsDirectory())
      await act(async () => {})
      expect(result.current).toMatchObject({ hydrated: false, failed: true, contacts: [] })
      await act(() => vi.advanceTimersByTimeAsync(5_000))
      expect(result.current).toMatchObject({ hydrated: false, failed: true })
      await act(() => vi.advanceTimersByTimeAsync(5_000))
      expect(result.current).toMatchObject({ hydrated: true, failed: false })
      expect(result.current.contacts[0]?.tag).toBe("theo")
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it("stops retrying once unmounted, even when a read fails after the unmount", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      let reject!: (error: Error) => void
      const read = vi.fn(() => new Promise<Contact[]>((_, rejectRead) => (reject = rejectRead)))
      mockRead.current = read
      const { unmount } = renderHook(() => useContactsDirectory())
      unmount()
      await act(async () => reject(new Error("read failed")))
      await act(() => vi.advanceTimersByTimeAsync(20_000))
      expect(read).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it("does not apply a read that a later read overtook", async () => {
    const reads: Array<(entries: Contact[]) => void> = []
    mockRead.current = () => new Promise<Contact[]>((resolve) => reads.push(resolve))
    const { result } = renderHook(() => useContactsDirectory())
    act(() => mockListeners.forEach((listener) => listener()))
    expect(reads).toHaveLength(2)
    await act(async () => reads[1]!([{ name: "Theo", address: L2_ADDRESS, tag: "theo" }]))
    await act(async () => reads[0]!([]))
    expect(result.current.contacts.map((c) => c.tag)).toEqual(["theo"])
  })

  it("keeps the last good contacts when a later read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      mockEntries.current = [{ name: "Theo", address: L2_ADDRESS, tag: "theo" }]
      const { result } = renderHook(() => useContactsDirectory())
      await waitFor(() => expect(result.current.hydrated).toBe(true))
      mockFailures.current = 1
      act(() => mockListeners.forEach((listener) => listener()))
      await waitFor(() => expect(result.current.failed).toBe(true))
      expect(result.current).toMatchObject({ hydrated: true, contacts: [{ tag: "theo" }] })
    } finally {
      warn.mockRestore()
    }
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
