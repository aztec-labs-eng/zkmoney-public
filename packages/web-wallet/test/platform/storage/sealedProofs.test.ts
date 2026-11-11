// @vitest-environment node
import { describe, expect, it } from "vitest"
import { ZKJWT_PUBLIC_INPUT_COUNT } from "@obsidion/core/constants"
import {
  ZKJWT_EMAIL_HASH_VERSION,
  createZkJwtProofs,
  memoryBackend,
  openDatabase,
  type ZkJwtProof,
} from "@obsidion/front-core"
import { MskWebCryptoProvider } from "../../../src/platform/storage/MskWebCryptoProvider"

const NOW = Date.now()
const keyed = (byte: number) => ({ getDerivedKey: async () => new Uint8Array(32).fill(byte) })

const proof: ZkJwtProof = {
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
  },
}

describe("zkJWT proofs under the MSK-derived key", () => {
  it("round-trip through AES-GCM, hold no plaintext, and open under no other key", async () => {
    const backend = memoryBackend()
    const proofs = createZkJwtProofs({
      db: openDatabase(backend).scoped("ns."),
      now: () => Date.now(),
    })
    const sealer = new MskWebCryptoProvider(keyed(1), "zkjwt-store")
    await proofs.save(sealer, proof)

    expect(await proofs.find(sealer, "0xcaller", "0xcommit", NOW)).toEqual(proof)
    const stored = [...backend.entries.values()].join()
    expect(stored).not.toContain("alice@example.com")
    expect(stored).not.toContain("0xcaller")
    const other = new MskWebCryptoProvider(keyed(2), "zkjwt-store")
    await expect(proofs.find(other, "0xcaller", "0xcommit", NOW)).rejects.toThrow()
  })
})
