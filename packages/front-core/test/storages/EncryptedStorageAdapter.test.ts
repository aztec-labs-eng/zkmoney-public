import { beforeEach, describe, expect, it } from "vitest"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { EncryptedStorageAdapter } from "../../src/core/storages/EncryptedStorageAdapter"
import type { CryptoProvider } from "../../src/core/storages/CryptoProvider"

/**
 * Fake CryptoProvider — XOR-cipher with HMAC-SHA256 authentication tag.
 *
 * Not a real AEAD, but it satisfies the contract: encrypt produces a self-
 * contained ciphertext, decrypt rejects tampering. Keeps tests fast in Node
 * without pulling in a real AES dependency, while still exercising the
 * adapter's "tamper detection ⇒ throw" path.
 */
function fakeAead(key: string): CryptoProvider {
  const keyBytes = new TextEncoder().encode(key)
  // Tiny FNV-style hash → 32-bit "MAC" — enough to detect single-byte flips
  // for unit-test assertions; not for production use.
  function mac(bytes: Uint8Array): number {
    let h = 0x811c9dc5
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i]
      h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
  }
  function xor(bytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ keyBytes[i % keyBytes.length]
    return out
  }
  const listeners = new Set<() => void>()
  return {
    async encrypt(plaintext: string): Promise<string> {
      const pt = new TextEncoder().encode(plaintext)
      const ct = xor(pt)
      const tag = mac(pt).toString(16).padStart(8, "0")
      // hex-encode ciphertext so it round-trips through string storage.
      let ctHex = ""
      for (const b of ct) ctHex += b.toString(16).padStart(2, "0")
      return `${ctHex}:${tag}`
    },
    async decrypt(ciphertext: string): Promise<string> {
      const [ctHex, tag] = ciphertext.split(":")
      if (!ctHex || !tag) throw new Error("malformed envelope")
      const ct = new Uint8Array(ctHex.length / 2)
      for (let i = 0; i < ct.length; i++) {
        ct[i] = parseInt(ctHex.substring(i * 2, i * 2 + 2), 16)
      }
      const pt = xor(ct)
      const expected = mac(pt).toString(16).padStart(8, "0")
      if (expected !== tag) throw new Error("authentication failure")
      return new TextDecoder().decode(pt)
    },
    keyAvailable() {
      return true
    },
    onKeyChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

describe("EncryptedStorageAdapter", () => {
  let inner: InMemoryStorageAdapter
  let crypto: CryptoProvider
  let adapter: EncryptedStorageAdapter

  beforeEach(() => {
    inner = new InMemoryStorageAdapter()
    crypto = fakeAead("hardcoded-test-key-32-bytes-long-for-aes")
    adapter = new EncryptedStorageAdapter(inner, crypto)
  })

  describe("isEncrypted brand check", () => {
    it("recognizes itself as encrypted", () => {
      expect(EncryptedStorageAdapter.isEncrypted(adapter)).toBe(true)
    })

    it("rejects a plain InMemoryStorageAdapter", () => {
      expect(EncryptedStorageAdapter.isEncrypted(inner)).toBe(false)
    })

    it("rejects null- and primitive-like inputs without throwing", () => {
      expect(EncryptedStorageAdapter.isEncrypted(null as unknown as InMemoryStorageAdapter)).toBe(
        false,
      )
      expect(EncryptedStorageAdapter.isEncrypted({} as InMemoryStorageAdapter)).toBe(false)
    })
  })

  describe("setItem / getItem round-trip", () => {
    it("stores ciphertext under the inner adapter and decrypts on read", async () => {
      await adapter.setItem("key", "secret-plaintext")
      const stored = await inner.getItem("key")
      expect(stored).not.toBeNull()
      expect(stored).not.toContain("secret-plaintext")

      const round = await adapter.getItem("key")
      expect(round).toBe("secret-plaintext")
    })

    it("returns null for absent keys (does NOT call decrypt)", async () => {
      const value = await adapter.getItem("missing")
      expect(value).toBeNull()
    })

    it("removeItem and clear delegate to the inner adapter", async () => {
      await adapter.setItem("k1", "v1")
      await adapter.setItem("k2", "v2")
      await adapter.removeItem("k1")
      expect(await adapter.getItem("k1")).toBeNull()
      expect(await adapter.getItem("k2")).toBe("v2")

      await adapter.clear()
      expect(await adapter.getItem("k2")).toBeNull()
    })
  })

  describe("tampering and rotation", () => {
    it("throws on tampered ciphertext rather than returning corrupted data", async () => {
      await adapter.setItem("key", "secret-plaintext")
      const stored = (await inner.getItem("key"))!
      // Flip a character in the ciphertext payload (before the colon delimiter).
      const tampered = stored[0] === "0" ? "1" + stored.slice(1) : "0" + stored.slice(1)
      await inner.setItem("key", tampered)

      await expect(adapter.getItem("key")).rejects.toThrow(/authentication failure/)
    })

    it("throws on a malformed envelope", async () => {
      await inner.setItem("key", "not-a-real-envelope")
      await expect(adapter.getItem("key")).rejects.toThrow(/malformed envelope/)
    })

    it("rotated key fails to decrypt the old ciphertext", async () => {
      await adapter.setItem("key", "secret")
      const rotated = new EncryptedStorageAdapter(inner, fakeAead("a-different-key"))
      await expect(rotated.getItem("key")).rejects.toThrow()
    })
  })
})
