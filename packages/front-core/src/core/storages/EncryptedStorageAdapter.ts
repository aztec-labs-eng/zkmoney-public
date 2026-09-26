/**
 * EncryptedStorageAdapter — wraps an underlying `IStorageAdapter` and
 * encrypts every value before `setItem`, decrypts on `getItem`. Used by
 * `PendingTxStore` and `ZkJwtStorage`, which share one MSK-derived adapter.
 *
 * The actual encryption primitive is supplied by the injected
 * `CryptoProvider` so front-core never imports a platform key store. Web
 * injects `MskWebCryptoProvider`; tests inject a fake AES-256-GCM provider with a hardcoded key.
 *
 * Brand check: `PendingTxStore.get(storage)` calls
 * `EncryptedStorageAdapter.isEncrypted(storage)` to enforce that consumers
 * cannot pass an unwrapped adapter. The brand is a private symbol attached
 * to instances at construction; subclassing or `instanceof` is not relied
 * upon (cross-realm safety).
 */

import type { IStorageAdapter } from "./adapter"
import type { CryptoProvider } from "./CryptoProvider"

const ENCRYPTED_BRAND = Symbol.for("@obsidion/front-core/EncryptedStorageAdapter")

export class EncryptedStorageAdapter implements IStorageAdapter {
  private readonly inner: IStorageAdapter
  private readonly crypto: CryptoProvider

  // Brand tag — checked by `PendingTxStore.get` to refuse plain adapters.
  // Symbol.for(...) means cross-realm checks still work.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;[ENCRYPTED_BRAND]: true = true

  constructor(inner: IStorageAdapter, crypto: CryptoProvider) {
    this.inner = inner
    this.crypto = crypto
  }

  static isEncrypted(adapter: IStorageAdapter): adapter is EncryptedStorageAdapter {
    return (
      adapter !== null &&
      typeof adapter === "object" &&
      (adapter as unknown as Record<symbol, unknown>)[ENCRYPTED_BRAND] === true
    )
  }

  async getItem(key: string): Promise<string | null> {
    const ciphertext = await this.inner.getItem(key)
    if (ciphertext === null) return null
    // Decryption errors (key rotation, tampering) propagate. The caller is
    // expected to differentiate "no record" (null) from "could not decrypt"
    // (throw) — see `PendingTxStore.load()` for the drop-on-rotation path.
    return await this.crypto.decrypt(ciphertext)
  }

  async setItem(key: string, value: string): Promise<void> {
    const ciphertext = await this.crypto.encrypt(value)
    await this.inner.setItem(key, ciphertext)
  }

  async removeItem(key: string): Promise<void> {
    await this.inner.removeItem(key)
  }

  async clear(): Promise<void> {
    await this.inner.clear()
  }
}
