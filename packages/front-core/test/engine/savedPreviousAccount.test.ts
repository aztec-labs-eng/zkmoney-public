import { describe, expect, it, vi } from "vitest"
import { openDatabase } from "../../src/engine/database"
import { WalletError } from "../../src/engine/errors"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { createSavedPreviousAccount } from "../../src/engine/savedPreviousAccount"

const PREVIOUS = `0x${"0d".repeat(32)}`
const OTHER = `0x${"0c".repeat(32)}`
const move = (txHash: string) => ({
  destination: `0x${"0e".repeat(32)}`,
  txHash,
  expiresAtMs: 1_000,
  amount: 10n ** 18n,
})

/** The address a session opened on `backend` reads once its load lands. */
async function reopened(backend: ReturnType<typeof memoryBackend>) {
  const { address } = createSavedPreviousAccount(openDatabase(backend))
  const off = address.subscribe(() => {})
  await vi.waitFor(() => expect(address.get()).not.toBeUndefined())
  off()
  return address.get()
}

describe("createSavedPreviousAccount", () => {
  it("keeps the found address for the next session, and forgets it when told", async () => {
    const backend = memoryBackend()
    const saved = createSavedPreviousAccount(openDatabase(backend))
    const off = saved.address.subscribe(() => {})
    await saved.save(PREVIOUS)
    expect(await reopened(backend)).toBe(PREVIOUS)
    await vi.waitFor(() => expect(saved.address.get()).toBe(PREVIOUS))

    await saved.save(undefined)
    await vi.waitFor(() => expect(saved.address.get()).toBeUndefined())
    off()
  })

  it("keeps the chunk in flight across a reopen, clears it only by its hash, and drops it for a new address", async () => {
    const backend = memoryBackend()
    await createSavedPreviousAccount(openDatabase(backend)).saveMove(PREVIOUS, move("0x01"))
    const saved = createSavedPreviousAccount(openDatabase(backend))
    expect(await saved.move(PREVIOUS)).toEqual(move("0x01"))
    expect(await saved.move(OTHER)).toBeUndefined()

    await saved.clearMove(PREVIOUS, "0x02")
    expect(await saved.move(PREVIOUS)).toEqual(move("0x01"))
    await saved.save(PREVIOUS)
    expect(await saved.move(PREVIOUS)).toEqual(move("0x01"))

    await saved.save(OTHER)
    expect(await saved.move(PREVIOUS)).toBeUndefined()
    await saved.saveMove(OTHER, move("0x03"))
    await saved.clearMove(OTHER, "0x03")
    expect(await saved.move(OTHER)).toBeUndefined()
  })

  it("fails every read and write while a saved chunk does not read, and keeps its bytes", async () => {
    const backend = memoryBackend()
    await createSavedPreviousAccount(openDatabase(backend)).saveMove(PREVIOUS, move("0x01"))
    const [key] = [...backend.entries.keys()].filter((k) => k.startsWith("acct/previousAccount/"))
    const raw = JSON.stringify({ id: "previous", address: PREVIOUS, move: { txHash: "0x01" } })
    backend.entries.set(key, raw)
    const saved = createSavedPreviousAccount(openDatabase(backend))
    await expect(saved.move(PREVIOUS)).rejects.toBeInstanceOf(WalletError)
    await expect(saved.saveMove(PREVIOUS, move("0x02"))).rejects.toBeInstanceOf(WalletError)
    expect(backend.entries.get(key)).toBe(raw)
  })
})
