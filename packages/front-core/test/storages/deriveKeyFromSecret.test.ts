/**
 * Unit tests for `deriveKeyFromSecret` — the single source of truth for
 * poseidon2 domain-separated key derivation shared by the
 * `AlphaAuthService.getDerivedKey` implementations and the XMTP DB-key path.
 *
 * Mocks `@aztec/foundation/crypto/poseidon` (bb.js/Barretenberg is unreliable under
 * jsdom/vitest) with a deterministic fake; real `Fr` is used because only the
 * hashing path is unreliable. The mock is deterministic so the tests assert the
 * correct (secret, separator) tuple flows in.
 *
 * Coverage honesty: because poseidon is mocked, these prove separator wiring +
 * the `toBuffer()`→`Uint8Array` conversion plumbing, NOT that real BN254
 * poseidon is stable. Real-derivation stability is inherited from the unchanged
 * primitive and exercised on-device.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@aztec/foundation/crypto/poseidon", () => ({
  poseidon2HashWithSeparator: vi.fn(
    async (input: Array<{ toBuffer: () => Buffer }>, sep: number) => {
      // Deterministic fake: byte 0 = (separator & 0xff), rest = first input's
      // bytes XOR (sep & 0xff). Detects both separator wiring and secret plumbing.
      const inBuf = input[0].toBuffer()
      const out = new Uint8Array(32)
      out[0] = sep & 0xff
      for (let i = 1; i < 32; i++) out[i] = inBuf[i]! ^ (sep & 0xff)
      return { toBuffer: () => Buffer.from(out) }
    },
  ),
}))

import { Fr } from "@aztec/aztec.js/fields"
import { poseidon2HashWithSeparator } from "@aztec/foundation/crypto/poseidon"

import { deriveKeyFromSecret, DOMAIN_SEPARATORS } from "../../src/core/storages/index"

describe("DOMAIN_SEPARATORS registry", () => {
  it("has unique selector values (no two domains collide)", () => {
    const values = Object.values(DOMAIN_SEPARATORS)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe("deriveKeyFromSecret", () => {
  // Block body (not a concise arrow): `mockClear()` returns the mock itself, and
  // a hook that returns a function registers it as a teardown callback — vitest
  // would then invoke the poseidon mock with no args during cleanup.
  beforeEach(() => {
    vi.mocked(poseidon2HashWithSeparator).mockClear()
  })

  it("returns a 32-byte Uint8Array for a known domain", async () => {
    const key = await deriveKeyFromSecret(new Fr(1234n), "xmtp-store")
    expect(key).toBeInstanceOf(Uint8Array)
    expect(key.length).toBe(32)
  })

  it("threads the domain's separator into the hash (xmtp-store)", async () => {
    const key = await deriveKeyFromSecret(new Fr(1234n), "xmtp-store")
    // Under the fake, byte 0 == separator & 0xff.
    expect(key[0]).toBe(DOMAIN_SEPARATORS["xmtp-store"]! & 0xff)
    const [inputs, sep] = vi.mocked(poseidon2HashWithSeparator).mock.calls[0]!
    expect(sep).toBe(DOMAIN_SEPARATORS["xmtp-store"])
    expect((inputs[0] as Fr).toString()).toBe(new Fr(1234n).toString())
  })

  it("is deterministic — same secret + domain yields identical bytes", async () => {
    const a = await deriveKeyFromSecret(new Fr(42n), "xmtp-store")
    const b = await deriveKeyFromSecret(new Fr(42n), "xmtp-store")
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it("separates domains — xmtp-store and pending-store derive different keys", async () => {
    const secret = new Fr(7n)
    const xmtp = await deriveKeyFromSecret(secret, "xmtp-store")
    const pending = await deriveKeyFromSecret(secret, "pending-store")
    expect(Buffer.from(xmtp).equals(Buffer.from(pending))).toBe(false)
    expect(xmtp[0]).not.toBe(pending[0])
  })

  it("separates secrets — different secrets derive different keys", async () => {
    const k1 = await deriveKeyFromSecret(new Fr(1n), "xmtp-store")
    const k2 = await deriveKeyFromSecret(new Fr(2n), "xmtp-store")
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(false)
  })

  it("rejects an unknown domain before hashing", async () => {
    await expect(deriveKeyFromSecret(new Fr(1n), "not-a-real-domain")).rejects.toThrow(
      "Unknown derived-key domain: not-a-real-domain",
    )
    expect(poseidon2HashWithSeparator).not.toHaveBeenCalled()
  })

  it("throws when the hash output is not 32 bytes", async () => {
    vi.mocked(poseidon2HashWithSeparator).mockImplementationOnce(
      async () => ({ toBuffer: () => Buffer.alloc(31) }) as never,
    )
    await expect(deriveKeyFromSecret(new Fr(1n), "xmtp-store")).rejects.toThrow(
      /must be 32 bytes/,
    )
  })
})
