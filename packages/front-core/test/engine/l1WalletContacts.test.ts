import { beforeEach, describe, expect, it, vi } from "vitest"

import { L1_PLACEHOLDER_NAME, createContacts, type Contacts } from "../../src/engine/contacts"
import { openDatabase } from "../../src/engine/database"
import {
  ensContactNames,
  updateSavedL1WalletContact,
  upsertDepositL1WalletContact,
  upsertSavedL1WalletContact,
} from "../../src/engine/l1WalletContacts"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { ensNames, type EnsClient, type EnsNames } from "../../src/core/services/ens"
import { queries } from "../../src/engine/query"
import { createPace } from "@obsidion/core/cadence"
import { memoryStore } from "../../src/engine/store"
import { startRuntime } from "../../src/engine/runtime"
import { sessions } from "./taskTable"

const testQueries = () =>
  queries({ pace: createPace(), visible: memoryStore(true).readonly, now: () => Date.now() })

const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01"
const COLD = "Cold wallet"
const SAVINGS = "Savings"
const ETHERFI = "ether.fi Cash"
const ZERO = "0x0000000000000000000000000000000000000000"

let contacts: Contacts
const backend = () => memoryBackend()
let held = backend()

beforeEach(() => {
  held = backend()
  contacts = createContacts({ db: openDatabase(held), now: () => Date.now() })
})

describe("upsertDepositL1WalletContact", () => {
  it("writes a deposit-attested row with session wallet metadata", async () => {
    await upsertDepositL1WalletContact(contacts, {
      address: ADDR,
      walletName: "MetaMask",
      walletImageUrl: "https://example/mm.png",
      walletProvider: "metamask",
      walletId: "mm-id",
      lastUsedAt: 1234,
    })

    const [entry] = await contacts.all()
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
    await upsertDepositL1WalletContact(contacts, { address: ADDR })

    const [entry] = await contacts.all()
    expect(entry).toMatchObject({
      name: L1_PLACEHOLDER_NAME,
      l1Wallet: { provider: "unknown", provenance: "deposit-attested" },
    })
    expect(entry.avatar).toBeUndefined()
  })

  it("ignores unknown or placeholder addresses", async () => {
    await upsertDepositL1WalletContact(contacts, { address: "unknown" })
    expect(await contacts.all()).toEqual([])
  })

  it("does not persist a contact for a mint (zero-address funder)", async () => {
    await upsertDepositL1WalletContact(contacts, { address: ZERO })
    expect(await contacts.all()).toEqual([])
  })

  it("swallows storage errors", async () => {
    await contacts.ready
    held.failing.commits = true
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect(upsertDepositL1WalletContact(contacts, { address: ADDR })).resolves.toBeUndefined()
    warn.mockRestore()
  })
})

describe("upsertSavedL1WalletContact", () => {
  it("writes a saved-recipient row with a user label", async () => {
    await upsertSavedL1WalletContact(contacts, {
      address: ADDR,
      name: COLD,
      lastUsedAt: 9,
    })

    const [entry] = await contacts.all()
    expect(entry).toMatchObject({
      name: COLD,
      address: ADDR,
      l1Wallet: {
        provider: "manual",
        walletName: COLD,
        provenance: "saved-recipient",
        userLabeled: true,
        lastUsedAt: 9,
      },
    })
  })

  it("defaults a nameless recipient to External Wallet without userLabeled", async () => {
    await upsertSavedL1WalletContact(contacts, { address: ADDR, lastUsedAt: 1 })

    const [entry] = await contacts.all()
    expect(entry).toMatchObject({
      name: L1_PLACEHOLDER_NAME,
      l1Wallet: { provider: "manual", provenance: "saved-recipient" },
    })
    expect(entry.l1Wallet?.userLabeled).toBeUndefined()
  })

  it("keeps a real provider, and a later manual save of the address merges into it", async () => {
    await upsertSavedL1WalletContact(contacts, {
      address: ADDR,
      name: ETHERFI,
      provider: "etherfi",
    })
    await upsertSavedL1WalletContact(contacts, { address: ADDR, name: ETHERFI })

    const entries = await contacts.all()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: ETHERFI,
      l1Wallet: { provider: "etherfi", provenance: "saved-recipient", userLabeled: true },
    })
  })

  it("skips the zero address", async () => {
    await upsertSavedL1WalletContact(contacts, { address: ZERO, name: "Faucet" })
    expect(await contacts.all()).toEqual([])
  })
})

describe("updateSavedL1WalletContact", () => {
  it("rewrites the label in place without changing the address", async () => {
    await upsertSavedL1WalletContact(contacts, { address: ADDR, name: "Old label" })

    const updated = await updateSavedL1WalletContact(contacts, {
      originalAddress: ADDR,
      provider: "manual",
      address: ADDR,
      name: COLD,
    })

    expect(updated).toMatchObject({ name: COLD, address: ADDR })
    const entries = await contacts.all()
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe(COLD)
  })

  it("clears an empty name back to External Wallet", async () => {
    await upsertSavedL1WalletContact(contacts, { address: ADDR, name: COLD })

    const updated = await updateSavedL1WalletContact(contacts, {
      originalAddress: ADDR,
      provider: "manual",
      address: ADDR,
      name: "  ",
    })

    expect(updated.name).toBe(L1_PLACEHOLDER_NAME)
    expect(updated.l1Wallet?.userLabeled).toBeUndefined()
  })

  it("throws for a mint (zero-address) instead of writing", async () => {
    await expect(
      updateSavedL1WalletContact(contacts, {
        originalAddress: ZERO,
        provider: "manual",
        address: ZERO,
        name: "Faucet",
      }),
    ).rejects.toMatchObject({ code: "unknown" })
    expect(await contacts.all()).toEqual([])
  })
})

/** The task in a runtime of its own; returns its stop. */
function naming(names: EnsNames): () => void {
  const runtime = sessions(startRuntime)
  runtime.tasks.push(ensContactNames(contacts, names))
  runtime.start()
  return runtime.end
}

describe("ensContactNames", () => {
  const getClient = () => ({ getEnsName: async () => "niallinio.eth" } as unknown as EnsClient)

  it("names an unlabeled L1 contact after its ENS name, but keeps a user's label", async () => {
    const LABELED = "0x1111111111111111111111111111111111111111"
    await upsertSavedL1WalletContact(contacts, { address: ADDR })
    await upsertSavedL1WalletContact(contacts, { address: LABELED, name: SAVINGS })
    const stop = naming(ensNames(testQueries(), getClient))

    await vi.waitFor(async () => {
      const names = (await contacts.all()).map((e) => [e.address, e.name])
      expect(names).toEqual([
        [ADDR, "niallinio.eth"],
        [LABELED, SAVINGS],
      ])
    })
    stop()
  })
})

describe("ensContactNames, racing the user", () => {
  it("leaves a contact the user renamed while its ENS name was being looked up", async () => {
    const ADDR = "0x2222222222222222222222222222222222222222"
    await upsertSavedL1WalletContact(contacts, { address: ADDR })
    const renaming = async () => {
      await updateSavedL1WalletContact(contacts, {
        originalAddress: ADDR,
        provider: "manual",
        address: ADDR,
        name: SAVINGS,
      })
      return "late.eth"
    }
    const stop = naming(
      ensNames(testQueries(), () => ({ getEnsName: renaming } as unknown as EnsClient)),
    )

    await vi.waitFor(async () => expect((await contacts.all())[0].name).toBe(SAVINGS))
    await new Promise((r) => setTimeout(r, 20))
    expect((await contacts.all())[0].name).toBe(SAVINGS)
    stop()
  })
})
