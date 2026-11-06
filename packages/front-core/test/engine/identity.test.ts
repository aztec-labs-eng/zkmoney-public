// @vitest-environment node
import { CompleteAddress } from "@aztec-labs/stdlib/contract"
import { describe, expect, it } from "vitest"
import { ACCOUNT_STORAGE_KEY } from "../../src/core/storages/constants"
import { openDatabase } from "../../src/engine/database"
import {
  LEGACY_IDENTITY_KEY,
  createIdentity,
  stageIdentity,
  type WalletIdentity,
} from "../../src/engine/identity"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"

const NS = "webwallet.ns."
const RECORD = NS + "acct/identity/current"

async function account(backend: MemoryBackend) {
  const complete = await CompleteAddress.random()
  backend.entries.set(
    NS + ACCOUNT_STORAGE_KEY,
    JSON.stringify({ completeAddress: complete.toString(), signKeyConfig: { type: "webauthn" } }),
  )
  return complete.address.toString()
}

function open(backend: MemoryBackend, opened?: string) {
  const page = openDatabase(backend)
  const identity = createIdentity({ db: page.scoped(NS), legacy: page, opened: () => opened })
  return { page, identity }
}

const legacy = (backend: MemoryBackend, identity: WalletIdentity) =>
  backend.entries.set(LEGACY_IDENTITY_KEY, JSON.stringify(identity))

describe("createIdentity", () => {
  it("carries the legacy identity into the namespace of its account, and only once", async () => {
    const backend = memoryBackend()
    const saved = { handle: "alice", address: await account(backend), claimedAt: 1 }
    legacy(backend, saved)
    const { page, identity } = open(backend)
    await identity.ready
    expect(identity.get()).toEqual({ value: saved, loaded: true, failed: false })

    await page.write(async (w) => stageIdentity(w, NS, null))
    // A rollback build saves its record again; this build never reads it back.
    legacy(backend, saved)
    const reopened = open(backend).identity
    await reopened.ready
    expect(reopened.get().value).toBeNull()
  })

  it("leaves another account's legacy identity behind", async () => {
    const backend = memoryBackend()
    await account(backend)
    legacy(backend, { handle: "bob", address: `0x${"0b".repeat(32)}`, claimedAt: 1 })
    const { identity } = open(backend, `0x${"0b".repeat(32)}`)
    await identity.ready
    expect(identity.get().value).toBeNull()
    expect(backend.entries.has(LEGACY_IDENTITY_KEY)).toBe(true)
  })

  it("matches the passkey's address in a namespace that saved no account", async () => {
    const address = `0x${"0A".repeat(32)}`
    const backend = memoryBackend()
    legacy(backend, { address, claimedAt: 1 })
    const carried = open(backend, address.toLowerCase()).identity
    await carried.ready
    expect(carried.get().value).toEqual({ address, claimedAt: 1 })

    const other = memoryBackend()
    legacy(other, { address, claimedAt: 1 })
    const left = open(other, `0x${"0c".repeat(32)}`).identity
    await left.ready
    expect(left.get().value).toBeNull()
  })

  it("writes the legacy key beside each change, for a rollback build", async () => {
    const backend = memoryBackend()
    const { page, identity } = open(backend)
    await identity.ready
    const saved = { address: "0x1", claimedAt: 2, handle: "carol", pending: true }

    await page.write(async (w) => stageIdentity(w, NS, saved))
    expect(identity.get().value).toEqual(saved)
    expect(JSON.parse(backend.entries.get(LEGACY_IDENTITY_KEY)!)).toEqual(saved)

    await page.write(async (w) => stageIdentity(w, NS, null))
    expect(identity.get().value).toBeNull()
    expect(backend.entries.has(LEGACY_IDENTITY_KEY)).toBe(false)
  })

  it("keeps the identity when a commit fails", async () => {
    const backend = memoryBackend()
    const { page, identity } = open(backend)
    await identity.ready
    const saved = { address: "0x1", claimedAt: 2 }
    await page.write(async (w) => stageIdentity(w, NS, saved))

    backend.failing.commits = true
    await expect(page.write(async (w) => stageIdentity(w, NS, null))).rejects.toThrow()
    expect(identity.get().value).toEqual(saved)
    expect(backend.entries.has(RECORD)).toBe(true)
  })

  it("reads as failed, never as absent, when it cannot be read", async () => {
    const backend = memoryBackend()
    backend.failing.reads = true
    const { identity } = open(backend)
    await expect(identity.ready).rejects.toThrow()
    expect(identity.get()).toMatchObject({ failed: true, value: null })
  })
})
