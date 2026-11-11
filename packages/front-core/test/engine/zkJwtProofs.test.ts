import { describe, expect, it } from "vitest"
import { ZKJWT_PUBLIC_INPUT_COUNT } from "@obsidion/core/constants"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import {
  ZKJWT_EMAIL_HASH_VERSION,
  createZkJwtProofs,
  type ProofSealer,
  type ZkJwtProof,
} from "../../src/engine/zkJwtProofs"

const NS = "obsidion.ns."
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** Reversible and key-bound, so a sealed record holds no plaintext and another key cannot open it. */
const sealer = (key: string): ProofSealer => ({
  encrypt: async (plain) => `${key}:${Buffer.from(plain).toString("base64")}`,
  decrypt: async (sealed) => {
    if (!sealed.startsWith(`${key}:`)) throw new Error("wrong key")
    return Buffer.from(sealed.slice(key.length + 1), "base64").toString()
  },
})
const KEY = sealer("k1")

const proof = (over: Partial<ZkJwtProof["metadata"]> = {}): ZkJwtProof => ({
  proof: ["0x1"],
  vkey: ["0x2"],
  publicInputs: Array.from({ length: ZKJWT_PUBLIC_INPUT_COUNT }, (_, i) => `0x${i}`),
  metadata: {
    hashVersion: ZKJWT_EMAIL_HASH_VERSION,
    iat: Math.floor(NOW / 1000),
    jwkId: "jwk",
    issHash: "0xiss",
    audHash: "0xaud",
    commitment: "0xcommit",
    callerAddress: "0xcaller",
    cachedAt: NOW,
    provider: "google",
    email: "alice@example.com",
    ...over,
  },
})

const open = (backend: MemoryBackend) =>
  createZkJwtProofs({ db: openDatabase(backend).scoped(NS), now: () => Date.now() })
const records = (backend: MemoryBackend) =>
  [...backend.entries].filter(([key]) => key.startsWith(`${NS}acct/zkJwtProofs/`))

describe("createZkJwtProofs", () => {
  it("opens empty and removes the dead stores' keys, once", async () => {
    const backend = memoryBackend()
    const dead = [
      "@obsidion/zkjwt/state",
      "@obsidion/zkjwt/proof-cache",
      "obsidion_issued_connects",
      "obsidion_pending_connect_backs",
    ].map((key) => `${NS}${key}`)
    for (const key of dead) backend.entries.set(key, "kept-by-an-older-build")
    const proofs = open(backend)
    await proofs.ready
    expect(await proofs.find(KEY, "0xcaller", "0xcommit", NOW)).toBeUndefined()
    expect(dead.filter((key) => backend.entries.has(key))).toEqual([])

    // A store already at version 2 reads none of them again.
    backend.entries.set(dead[0], "written-later")
    await open(backend).ready
    expect(backend.entries.get(dead[0])).toBe("written-later")
  })

  it("carries a version 1 store's proofs into version 2", async () => {
    const backend = memoryBackend()
    await open(backend).save(KEY, proof())
    backend.entries.set(`${NS}acct/meta/zkJwtProofs`, "1")
    backend.entries.set(`${NS}obsidion_issued_connects`, "[]")
    const proofs = open(backend)
    expect(await proofs.find(KEY, "0xcaller", "0xcommit", NOW)).toEqual(proof())
    expect(backend.entries.has(`${NS}obsidion_issued_connects`)).toBe(false)
  })

  it("returns a saved proof for its caller and commitment, sealed at rest under a random id", async () => {
    const backend = memoryBackend()
    const proofs = open(backend)
    await proofs.save(KEY, proof())

    expect(await proofs.find(KEY, "0xcaller", "0xcommit", NOW)).toEqual(proof())
    expect(await proofs.find(KEY, "0xother", "0xcommit", NOW)).toBeUndefined()
    expect(await proofs.find(KEY, "0xcaller", "0xother", NOW)).toBeUndefined()
    const [[key, raw]] = records(backend)
    expect(key).not.toContain("0xcommit")
    expect(raw).not.toContain("alice@example.com")
    expect(raw).not.toContain("0xcaller")
  })

  it("survives a reopen", async () => {
    const backend = memoryBackend()
    await open(backend).save(KEY, proof())
    expect(await open(backend).find(KEY, "0xcaller", "0xcommit", NOW)).toEqual(proof())
  })

  it.each([
    ["an expired JWT", proof({ iat: Math.floor((NOW - 8 * DAY) / 1000) })],
    ["a proof saved over a week ago", proof({ cachedAt: NOW - 8 * DAY })],
    ["an older hash version", proof({ hashVersion: ZKJWT_EMAIL_HASH_VERSION - 1 })],
  ])("removes %s instead of returning it", async (_, stale) => {
    const backend = memoryBackend()
    const proofs = open(backend)
    await proofs.save(KEY, stale)
    expect(await proofs.find(KEY, "0xcaller", "0xcommit", NOW)).toBeUndefined()
    expect(records(backend)).toHaveLength(0)
  })

  it("rejects a find whose key cannot open a record, and keeps the record", async () => {
    const backend = memoryBackend()
    const proofs = open(backend)
    await proofs.save(sealer("k2"), proof())
    await expect(proofs.find(KEY, "0xcaller", "0xcommit", NOW)).rejects.toThrow()
    expect(records(backend)).toHaveLength(1)
  })

  it("keeps the newest ten proofs", async () => {
    const backend = memoryBackend()
    const proofs = open(backend)
    for (let i = 0; i < 11; i++)
      await proofs.save(KEY, proof({ commitment: `0xc${i}`, cachedAt: NOW - (11 - i) * 1000 }))

    expect(records(backend)).toHaveLength(10)
    expect(await proofs.find(KEY, "0xcaller", "0xc0", NOW)).toBeUndefined()
    expect(await proofs.find(KEY, "0xcaller", "0xc10", NOW)).toBeDefined()
  })

  it("keeps ten proofs when two saves overlap", async () => {
    const backend = memoryBackend()
    const proofs = open(backend)
    for (let i = 0; i < 10; i++)
      await proofs.save(KEY, proof({ commitment: `0xc${i}`, cachedAt: NOW - (10 - i) * 1000 }))

    await Promise.all([
      proofs.save(KEY, proof({ commitment: "0xa" })),
      proofs.save(KEY, proof({ commitment: "0xb" })),
    ])
    expect(records(backend)).toHaveLength(10)
  })

  it("rejects a save that fails to commit and keeps nothing", async () => {
    const backend = memoryBackend()
    const proofs = open(backend)
    await proofs.ready
    backend.failing.commits = true
    await expect(proofs.save(KEY, proof())).rejects.toThrow()
    expect(records(backend)).toHaveLength(0)
  })
})
