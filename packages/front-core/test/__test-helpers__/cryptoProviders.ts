import type { CryptoProvider } from "../../src/core/storages/CryptoProvider"

/**
 * Identity-cipher CryptoProvider — round-trips plaintext so an
 * `EncryptedStorageAdapter` wrapper satisfies the `isEncrypted` brand check
 * while the inner adapter still sees the original value. Use when a test
 * needs an encrypted adapter but doesn't care about the ciphertext shape.
 */
export function passThroughProvider(): CryptoProvider {
  return {
    async encrypt(p) {
      return p
    },
    async decrypt(c) {
      return c
    },
    keyAvailable() {
      return true
    },
    onKeyChanged() {
      return () => {}
    },
  }
}

/**
 * XOR-masking CryptoProvider — the inner adapter sees hex-encoded ciphertext,
 * not plaintext. Lets a test assert the encrypted-at-rest invariant (the raw
 * stored value must not contain the plaintext).
 */
export function maskingProvider(key = "obsidion-test-key"): CryptoProvider {
  const keyBytes = new TextEncoder().encode(key)
  const xor = (bytes: Uint8Array): Uint8Array => {
    const out = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i]! ^ keyBytes[i % keyBytes.length]!
    return out
  }
  return {
    async encrypt(plaintext) {
      const ct = xor(new TextEncoder().encode(plaintext))
      let hex = ""
      for (const b of ct) hex += b.toString(16).padStart(2, "0")
      return hex
    },
    async decrypt(ciphertext) {
      const ct = new Uint8Array(ciphertext.length / 2)
      for (let i = 0; i < ct.length; i++) {
        ct[i] = parseInt(ciphertext.substring(i * 2, i * 2 + 2), 16)
      }
      return new TextDecoder().decode(xor(ct))
    },
    keyAvailable() {
      return true
    },
    onKeyChanged() {
      return () => {}
    },
  }
}
