/**
 * Web `CryptoProvider` over WebCrypto AES-256-GCM, keyed by
 * `WebAlphaAuthService.getDerivedKey(domain)` (MSK-derived; the MSK itself never crosses
 * this module). Printable envelope: `<iv-hex>:<ciphertext-hex>:<auth-tag-hex>`. Callers pick the
 * domain (`zkjwt-store`,
 * `pending-store`, …) so each encrypted blob family has its own key.
 */
import type { AlphaAuthService } from "@obsidion/sdk"
import type { CryptoProvider, KnownDerivedKeyDomain } from "@obsidion/front-core"

const IV_BYTES = 12
const TAG_BYTES = 16

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("malformed ciphertext envelope (non-hex segment)")
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export class MskWebCryptoProvider implements CryptoProvider {
  private key?: CryptoKey

  constructor(
    private readonly authService: Pick<AlphaAuthService, "getDerivedKey">,
    private readonly domain: KnownDerivedKeyDomain,
  ) {}

  private async getKey(): Promise<CryptoKey> {
    if (this.key) return this.key
    const raw = await this.authService.getDerivedKey(this.domain)
    this.key = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ])
    return this.key
  }

  async encrypt(plaintext: string): Promise<string> {
    const key = await this.getKey()
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(plaintext),
      ),
    )
    // WebCrypto appends the tag to the ciphertext; split it out for the envelope.
    const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES)
    const tag = sealed.subarray(sealed.length - TAG_BYTES)
    return `${toHex(iv)}:${toHex(ciphertext)}:${toHex(tag)}`
  }

  async decrypt(envelope: string): Promise<string> {
    const parts = envelope.split(":")
    if (parts.length !== 3) throw new Error("malformed ciphertext envelope")
    const [iv, ciphertext, tag] = parts.map(fromHex)
    const key = await this.getKey()
    const sealed = new Uint8Array(ciphertext!.length + tag!.length)
    sealed.set(ciphertext!)
    sealed.set(tag!, ciphertext!.length)
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv! as BufferSource },
      key,
      sealed,
    )
    return new TextDecoder().decode(plain)
  }

  keyAvailable(): boolean {
    // `getDerivedKey` throws while the MSK is locked; callers gate on the unlocked account
    // before constructing the claim flow, so an optimistic true is safe here.
    return true
  }

  onKeyChanged(): () => void {
    // The web auth service holds one MSK for the tab's lifetime; the key never rotates, so the
    // listener would never fire.
    return () => {}
  }
}
