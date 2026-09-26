import { describe, it, expect, beforeEach } from "vitest"

import { ZkJwtStorage } from "../../../src/core/services/zkJwt/ZkJwtStorage"
import { EncryptedStorageAdapter } from "../../../src/core/storages/EncryptedStorageAdapter"
import type { CryptoProvider } from "../../../src/core/storages/CryptoProvider"
import { maskingProvider, passThroughProvider } from "../../__test-helpers__/cryptoProviders"
import { InMemoryStorageAdapter, makeMetadata } from "./fixtures/proofBundles"

const KEY_STATE = "@obsidion/zkjwt/state"
const KEY_PROOF_CACHE = "@obsidion/zkjwt/proof-cache"

describe("ZkJwtStorage", () => {
  let adapter: InMemoryStorageAdapter
  let storage: ZkJwtStorage

  beforeEach(() => {
    // Wrap the InMemory inner in an identity-cipher EncryptedStorageAdapter so
    // ZkJwtStorage's brand check passes while `adapter._seed`/reads stay valid.
    adapter = new InMemoryStorageAdapter()
    storage = new ZkJwtStorage(new EncryptedStorageAdapter(adapter, passThroughProvider()))
  })

  it("rejects a plain (unencrypted) IStorageAdapter", () => {
    expect(() => new ZkJwtStorage(new InMemoryStorageAdapter())).toThrow(
      /EncryptedStorageAdapter/,
    )
  })

  it("stores the proof cache encrypted at rest — no plaintext email/address on disk", async () => {
    const inner = new InMemoryStorageAdapter()
    const encStorage = new ZkJwtStorage(new EncryptedStorageAdapter(inner, maskingProvider()))
    await encStorage.saveProofCache(["p"], ["v"], ["pi"], makeMetadata({ commitment: "0xA" }))

    const raw = await inner.getItem(KEY_PROOF_CACHE)
    expect(raw).not.toBeNull()
    expect(raw).not.toContain("alice@example.com") // DEFAULTS.email
    expect(raw).not.toContain("0xCALLER") // DEFAULTS.caller
    // still round-trips back to plaintext through the adapter
    expect((await encStorage.getProof("0xA"))!.metadata.email).toBe("alice@example.com")
  })

  it("falls back to defaults and scrubs a value it cannot decrypt", async () => {
    const inner = new InMemoryStorageAdapter()
    // Provider whose decrypt always throws — a rotated MSK or a pre-encryption
    // plaintext blob left by an older build.
    const throwing: CryptoProvider = {
      async encrypt(p) {
        return p
      },
      async decrypt(): Promise<string> {
        throw new Error("cannot decrypt")
      },
      keyAvailable() {
        return true
      },
      onKeyChanged() {
        return () => {}
      },
    }
    const encStorage = new ZkJwtStorage(new EncryptedStorageAdapter(inner, throwing))
    inner._seed(KEY_STATE, "cached")
    inner._seed(KEY_PROOF_CACHE, "old-plaintext-blob")

    expect(await encStorage.getState()).toBe("idle")
    expect(await encStorage.listProofs()).toEqual([])
    // unreadable keys are scrubbed so stale plaintext doesn't linger
    expect(await inner.getItem(KEY_STATE)).toBeNull()
    expect(await inner.getItem(KEY_PROOF_CACHE)).toBeNull()
  })

  describe("state", () => {
    it("returns 'idle' when key is unset", async () => {
      expect(await storage.getState()).toBe("idle")
    })

    it("round-trips known states", async () => {
      await storage.setState("proving")
      expect(await storage.getState()).toBe("proving")
      await storage.setState("cached")
      expect(await storage.getState()).toBe("cached")
      await storage.setState("error")
      expect(await storage.getState()).toBe("error")
      await storage.setState("idle")
      expect(await storage.getState()).toBe("idle")
    })

    it("coerces unknown persisted values to 'idle'", async () => {
      adapter._seed(KEY_STATE, "bogus")
      expect(await storage.getState()).toBe("idle")
    })
  })

  describe("proof cache", () => {
    it("saveProofCache + getProof round-trips", async () => {
      const meta = makeMetadata({ commitment: "0xA" })
      await storage.saveProofCache(["p"], ["v"], ["pi"], meta)
      const bundle = await storage.getProof("0xA")
      expect(bundle).not.toBeNull()
      expect(bundle!.metadata).toEqual(meta)
      expect(bundle!.proof).toEqual(["p"])
      expect(bundle!.vkey).toEqual(["v"])
      expect(bundle!.publicInputs).toEqual(["pi"])
    })

    it("getProof returns null when commitment is missing", async () => {
      expect(await storage.getProof("0xMISSING")).toBeNull()
    })

    it("listProofs returns all bundles", async () => {
      await storage.saveProofCache(
        ["p1"],
        ["v1"],
        ["pi1"],
        makeMetadata({ commitment: "0xA" }),
      )
      await storage.saveProofCache(
        ["p2"],
        ["v2"],
        ["pi2"],
        makeMetadata({ commitment: "0xB" }),
      )
      const all = await storage.listProofs()
      expect(all).toHaveLength(2)
      expect(all.map((b) => b.metadata.commitment).sort()).toEqual(["0xA", "0xB"])
    })

    it("removeProof deletes the entry", async () => {
      await storage.saveProofCache(["p"], ["v"], ["pi"], makeMetadata({ commitment: "0xA" }))
      await storage.removeProof("0xA")
      expect(await storage.getProof("0xA")).toBeNull()
    })

    it("evicts the oldest-by-cachedAt entry when capacity (10) is reached", async () => {
      for (let i = 0; i < 10; i++) {
        await storage.saveProofCache(
          [`p${i}`],
          [`v${i}`],
          [`pi${i}`],
          makeMetadata({
            commitment: `0x${i.toString(16).padStart(2, "0")}`,
            cachedAt: 1_000 + i, // ascending
          }),
        )
      }
      expect(await storage.listProofs()).toHaveLength(10)

      // Insert a new entry — oldest (cachedAt=1000, "0x00") should be evicted
      await storage.saveProofCache(
        ["pNEW"],
        ["vNEW"],
        ["piNEW"],
        makeMetadata({ commitment: "0xNEW", cachedAt: 2_000 }),
      )
      const all = await storage.listProofs()
      expect(all).toHaveLength(10)
      expect(await storage.getProof("0x00")).toBeNull()
      expect(await storage.getProof("0xNEW")).not.toBeNull()
    })

    it("loadCache returns empty map when storage has corrupt JSON", async () => {
      adapter._seed(KEY_PROOF_CACHE, "{ not json")
      expect(await storage.listProofs()).toEqual([])
      expect(await storage.getProof("0xANY")).toBeNull()
    })

    it("hasAnyProof reflects cache population", async () => {
      expect(await storage.hasAnyProof()).toBe(false)
      await storage.saveProofCache(["p"], ["v"], ["pi"], makeMetadata({ commitment: "0xA" }))
      expect(await storage.hasAnyProof()).toBe(true)
      await storage.removeProof("0xA")
      expect(await storage.hasAnyProof()).toBe(false)
    })

    it("clearCache wipes both state and proof-cache keys", async () => {
      await storage.setState("cached")
      await storage.saveProofCache(["p"], ["v"], ["pi"], makeMetadata({ commitment: "0xA" }))
      await storage.clearCache()
      expect(await storage.getState()).toBe("idle")
      expect(await storage.listProofs()).toEqual([])
    })
  })
})
