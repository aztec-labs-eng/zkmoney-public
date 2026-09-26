import type { IStorageAdapter } from "../../../../src/core/storages/adapter"
import type {
  ProofBundle,
  ZkJwtCacheMetadata,
} from "../../../../src/core/services/zkJwt/ZkJwtStorage"
import { ZKJWT_EMAIL_HASH_VERSION } from "../../../../src/core/services/zkJwt/ZkJwtStorage"
import type {
  IZkJwtProver,
  ZkJwtProofResult,
} from "../../../../src/core/services/zkJwt/IZkJwtProver"

export class InMemoryStorageAdapter implements IStorageAdapter {
  private store = new Map<string, string>()

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key)
  }

  async clear(): Promise<void> {
    this.store.clear()
  }

  // Test-only helpers
  _snapshot(): Record<string, string> {
    return Object.fromEntries(this.store.entries())
  }

  _seed(key: string, value: string): void {
    this.store.set(key, value)
  }
}

export const DEFAULTS = {
  caller: "0xCALLER",
  commitment: "0xCOMMIT",
  jwkId: "0xJWK",
  issHash: "0xISS",
  audHash: "0xAUD",
  emailHash: "0xEMAIL",
  preEmailHash: "0xPREEMAIL",
  iat: 1776365419000, // ms
  cachedAt: 1776365519000, // ms (matches iat + a bit)
  email: "alice@example.com",
  provider: "google" as const,
}

export function makeMetadata(over: Partial<ZkJwtCacheMetadata> = {}): ZkJwtCacheMetadata {
  return {
    hashVersion: ZKJWT_EMAIL_HASH_VERSION,
    iat: DEFAULTS.iat,
    jwkId: DEFAULTS.jwkId,
    issHash: DEFAULTS.issHash,
    audHash: DEFAULTS.audHash,
    commitment: DEFAULTS.commitment,
    callerAddress: DEFAULTS.caller,
    cachedAt: DEFAULTS.cachedAt,
    provider: DEFAULTS.provider,
    email: DEFAULTS.email,
    ...over,
  }
}

export function makeBundle(
  over: Partial<ZkJwtCacheMetadata> = {},
  proofOver: Partial<Omit<ProofBundle, "metadata">> = {},
): ProofBundle {
  const metadata = makeMetadata(over)
  return {
    proof: ["0xproof1", "0xproof2"],
    vkey: ["0xvk1", "0xvk2"],
    publicInputs: [
      DEFAULTS.caller,
      DEFAULTS.emailHash,
      metadata.commitment,
      metadata.audHash,
      "0x" + metadata.iat.toString(16),
      metadata.jwkId,
      metadata.issHash,
    ],
    metadata,
    ...proofOver,
  }
}

export function makeProverResult(over: Partial<ZkJwtProofResult> = {}): ZkJwtProofResult {
  return {
    proof: ["0xproof1", "0xproof2"],
    vkey: ["0xvk1", "0xvk2"],
    publicInputs: [
      DEFAULTS.caller,
      DEFAULTS.emailHash,
      DEFAULTS.commitment,
      DEFAULTS.audHash,
      "0x" + DEFAULTS.iat.toString(16),
      DEFAULTS.jwkId,
      DEFAULTS.issHash,
    ],
    ...over,
  }
}

export class MockProver implements IZkJwtProver {
  prove = async (_input: unknown, _caller: string): Promise<ZkJwtProofResult> => {
    return makeProverResult()
  }
}
