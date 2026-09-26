import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  ContactStorage,
  updateSavedL1WalletContact,
  upsertDepositL1WalletContact,
  upsertSavedL1WalletContact,
} from "../../src/index.js"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01"
const ZERO = "0x0000000000000000000000000000000000000000"

beforeEach(() => {
  ContactStorage.resetForTests()
  ContactStorage.get(new InMemoryStorageAdapter())
})

describe("upsertDepositL1WalletContact", () => {
  it("writes a deposit-attested row with session wallet metadata", async () => {
    await upsertDepositL1WalletContact({
      address: ADDR,
      walletName: "MetaMask",
      walletImageUrl: "https://example/mm.png",
      walletProvider: "metamask",
      walletId: "mm-id",
      lastUsedAt: 1234,
    })

    const [entry] = await ContactStorage.get().getEntries()
    expect(entry).toMatchObject({
      name: "MetaMask",
      address: ADDR,
      addressKind: "ethereum-l1",
      avatar: { type: "image", url: "https://example/mm.png" },
      l1Wallet: {
        provider: "metamask",
        walletId: "mm-id",
        walletName: "MetaMask",
        imageUrl: "https://example/mm.png",
        provenance: "deposit-attested",
        lastUsedAt: 1234,
      },
    })
  })

  it("defaults an unlabeled funder to External Wallet / unknown", async () => {
    await upsertDepositL1WalletContact({ address: ADDR })

    const [entry] = await ContactStorage.get().getEntries()
    expect(entry).toMatchObject({
      name: "External Wallet",
      l1Wallet: { provider: "unknown", provenance: "deposit-attested" },
      avatar: undefined,
    })
  })

  it("ignores unknown or placeholder addresses", async () => {
    await upsertDepositL1WalletContact({ address: "unknown" })
    expect(await ContactStorage.get().getEntries()).toEqual([])
  })

  it("does not persist a contact for a mint (zero-address funder)", async () => {
    await upsertDepositL1WalletContact({ address: ZERO })
    expect(await ContactStorage.get().getEntries()).toEqual([])
  })

  it("swallows storage errors", async () => {
    ContactStorage.resetForTests()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect(upsertDepositL1WalletContact({ address: ADDR })).resolves.toBeUndefined()
    warn.mockRestore()
  })
})

describe("upsertSavedL1WalletContact", () => {
  it("writes a saved-recipient row with a user label", async () => {
    await upsertSavedL1WalletContact({ address: ADDR, name: "Cold wallet", lastUsedAt: 9 })

    const [entry] = await ContactStorage.get().getEntries()
    expect(entry).toMatchObject({
      name: "Cold wallet",
      address: ADDR,
      l1Wallet: {
        provider: "manual",
        walletName: "Cold wallet",
        provenance: "saved-recipient",
        userLabeled: true,
        lastUsedAt: 9,
      },
    })
  })

  it("defaults a nameless recipient to External Wallet without userLabeled", async () => {
    await upsertSavedL1WalletContact({ address: ADDR, lastUsedAt: 1 })

    const [entry] = await ContactStorage.get().getEntries()
    expect(entry).toMatchObject({
      name: "External Wallet",
      l1Wallet: {
        provider: "manual",
        provenance: "saved-recipient",
        userLabeled: undefined,
      },
    })
  })

  it("skips the zero address", async () => {
    await upsertSavedL1WalletContact({ address: ZERO, name: "Faucet" })
    expect(await ContactStorage.get().getEntries()).toEqual([])
  })
})

describe("updateSavedL1WalletContact", () => {
  it("rewrites the label in place without changing the address", async () => {
    await upsertSavedL1WalletContact({ address: ADDR, name: "Old label" })

    const updated = await updateSavedL1WalletContact({
      originalAddress: ADDR,
      provider: "manual",
      address: ADDR,
      name: "Cold wallet",
    })

    expect(updated).toMatchObject({ name: "Cold wallet", address: ADDR })
    const entries = await ContactStorage.get().getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe("Cold wallet")
  })

  it("clears an empty name back to External Wallet", async () => {
    await upsertSavedL1WalletContact({ address: ADDR, name: "Cold wallet" })

    const updated = await updateSavedL1WalletContact({
      originalAddress: ADDR,
      provider: "manual",
      address: ADDR,
      name: "  ",
    })

    expect(updated.name).toBe("External Wallet")
    expect(updated.l1Wallet?.userLabeled).toBeUndefined()
  })

  it("throws for a mint (zero-address) instead of writing", async () => {
    await expect(
      updateSavedL1WalletContact({
        originalAddress: ZERO,
        provider: "manual",
        address: ZERO,
        name: "Faucet",
      }),
    ).rejects.toThrow("Invalid address")
    expect(await ContactStorage.get().getEntries()).toEqual([])
  })
})
