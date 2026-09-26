import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// prepareJwtFromProvider + PublicKeyRegistry come from @obsidion/sdk; stub both
// so runProving tests don't pull the real SDK (JWT/RSA/BN254 crypto).
vi.mock("@obsidion/sdk", () => ({
  prepareJwtFromProvider: vi.fn(async () => ({
    input: { nonce_preimage: 0n } as unknown,
    subHash: 0n,
    emailHash: 0n,
    email: "alice@example.com",
    jwk_id: "0xJWK",
  })),
  PublicKeyRegistry: vi.fn(),
}))

import { ZkJwtService } from "../../../src/core/services/zkJwt/ZkJwtService"
import { ZkJwtStorage } from "../../../src/core/services/zkJwt/ZkJwtStorage"
import { EncryptedStorageAdapter } from "../../../src/core/storages/EncryptedStorageAdapter"
import { passThroughProvider } from "../../__test-helpers__/cryptoProviders"
import type {
  IZkJwtProver,
  ZkJwtProofResult,
} from "../../../src/core/services/zkJwt/IZkJwtProver"
import type { IZkJwtRegistryCheck } from "../../../src/core/services/zkJwt/IZkJwtRegistryCheck"
import {
  InMemoryStorageAdapter,
  DEFAULTS,
  makeMetadata,
  makeProverResult,
} from "./fixtures/proofBundles"

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
// Set "now" a few minutes after iat so proofs are fresh by default.
const NOW = (DEFAULTS.iat + 60) * 1000

interface BuildOpts {
  registry?: IZkJwtRegistryCheck
}

function build(opts: BuildOpts = {}): {
  service: ZkJwtService
  storage: ZkJwtStorage
  adapter: InMemoryStorageAdapter
  proveMock: ReturnType<typeof vi.fn>
} {
  const adapter = new InMemoryStorageAdapter()
  const storage = new ZkJwtStorage(new EncryptedStorageAdapter(adapter, passThroughProvider()))
  const proveMock = vi.fn(async () => makeProverResult())
  const prover: IZkJwtProver = { prove: proveMock }
  const service = new ZkJwtService({ prover, storage, registry: opts.registry })
  return { service, storage, adapter, proveMock }
}

function makeRegistry(over: Partial<IZkJwtRegistryCheck> = {}): {
  registry: IZkJwtRegistryCheck
  jwkMock: ReturnType<typeof vi.fn>
  audMock: ReturnType<typeof vi.fn>
} {
  const jwkMock = vi.fn(async () => true)
  const audMock = vi.fn(async () => true)
  const registry: IZkJwtRegistryCheck = {
    isValidJwk: over.isValidJwk ?? (jwkMock as unknown as IZkJwtRegistryCheck["isValidJwk"]),
    isAudAllowed: over.isAudAllowed ?? (audMock as unknown as IZkJwtRegistryCheck["isAudAllowed"]),
  }
  return { registry, jwkMock, audMock }
}

function publicInputs(): string[] {
  return [...makeProverResult().publicInputs]
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("ZkJwtService.isCacheValid", () => {
  it("returns true for a fresh bundle matching caller + commitment", () => {
    const { service } = build()
    const meta = makeMetadata({ cachedAt: NOW - 1_000 })
    expect(service.isCacheValid(meta, DEFAULTS.caller, DEFAULTS.commitment)).toBe(true)
  })

  it("returns false when the caller address changed", () => {
    const { service } = build()
    const meta = makeMetadata()
    expect(service.isCacheValid(meta, "0xDIFFERENT", DEFAULTS.commitment)).toBe(false)
  })

  it("returns false when the commitment mismatches", () => {
    const { service } = build()
    const meta = makeMetadata({ commitment: "0xA" })
    expect(service.isCacheValid(meta, DEFAULTS.caller, "0xB")).toBe(false)
  })

  // @CLAUDE: there should always be a commitment too check? What is this checking
  it("omitting commitment skips the commitment check", () => {
    const { service } = build()
    const meta = makeMetadata({ commitment: "0xA", cachedAt: NOW - 1_000 })
    expect(service.isCacheValid(meta, DEFAULTS.caller)).toBe(true)
  })

  it("returns false when iat is older than 1 week", () => {
    const { service } = build()
    const meta = makeMetadata({
      iat: Math.floor((NOW - ONE_WEEK_MS - 1_000) / 1000),
      cachedAt: NOW - 1_000,
    })
    expect(service.isCacheValid(meta, DEFAULTS.caller, DEFAULTS.commitment)).toBe(false)
  })

  it("returns false when cachedAt is older than 1 week even if iat is recent", () => {
    const { service } = build()
    const meta = makeMetadata({
      iat: Math.floor(NOW / 1000),
      cachedAt: NOW - ONE_WEEK_MS - 1_000,
    })
    expect(service.isCacheValid(meta, DEFAULTS.caller, DEFAULTS.commitment)).toBe(false)
  })
})

describe("ZkJwtService.matchProofForPaylink", () => {
  it("returns null without touching storage for non-paylinkEmail paylinks", async () => {
    const { service, adapter } = build()
    const spy = vi.spyOn(adapter, "getItem")
    const result = await service.matchProofForPaylink(
      DEFAULTS.caller,
      "paylinkDirect",
      DEFAULTS.commitment,
    )
    expect(result).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it("returns the cached proof for a valid paylinkEmail match", async () => {
    const { service, storage } = build()
    await storage.saveProofCache(
      ["p"],
      ["v"],
      publicInputs(),
      makeMetadata({ cachedAt: NOW - 1_000 }),
    )
    const result = await service.matchProofForPaylink(
      DEFAULTS.caller,
      "paylinkEmail",
      DEFAULTS.commitment,
    )
    expect(result).not.toBeNull()
    expect(result!.email).toBe(DEFAULTS.email)
    expect(result!.provider).toBe(DEFAULTS.provider)
    expect(result!.proof).toEqual(["p"])
    expect(result!.vkey).toEqual(["v"])
  })

  it("returns null when paylinkEmail cache is stale (iat expired)", async () => {
    const { service, storage } = build()
    const meta = makeMetadata({
      iat: Math.floor((NOW - ONE_WEEK_MS - 1_000) / 1000),
      cachedAt: NOW - 1_000,
    })
    await storage.saveProofCache(["p"], ["v"], publicInputs(), meta)
    expect(
      await service.matchProofForPaylink(DEFAULTS.caller, "paylinkEmail", DEFAULTS.commitment),
    ).toBeNull()
  })
})

describe("ZkJwtService.getCachedZkProof", () => {
  it("with commitment: returns proof when valid", async () => {
    const { service, storage } = build()
    await storage.saveProofCache(
      ["p"],
      ["v"],
      publicInputs(),
      makeMetadata({ cachedAt: NOW - 1_000 }),
    )
    const proof = await service.getCachedZkProof(DEFAULTS.caller, DEFAULTS.commitment)
    expect(proof).not.toBeNull()
    expect(proof!.email).toBe(DEFAULTS.email)
  })

  it("with commitment: returns null when no bundle stored", async () => {
    const { service } = build()
    expect(await service.getCachedZkProof(DEFAULTS.caller, "0xMISSING")).toBeNull()
  })

  it("returns null on caller mismatch without evicting", async () => {
    const { service, storage } = build()
    await storage.saveProofCache(
      ["p"],
      ["v"],
      publicInputs(),
      makeMetadata({
        cachedAt: NOW - 1_000,
        callerAddress: "0xOTHER",
      }),
    )
    expect(await service.getCachedZkProof(DEFAULTS.caller, DEFAULTS.commitment)).toBeNull()
    // Bundle was for another caller — retain it
    expect(await storage.hasAnyProof()).toBe(true)
  })

  it("evicts and returns null when bundle is durably invalid (iat expired)", async () => {
    const { service, storage } = build()
    await storage.saveProofCache(
      ["p"],
      ["v"],
      publicInputs(),
      makeMetadata({
        iat: Math.floor((NOW - ONE_WEEK_MS - 1_000) / 1000),
        cachedAt: NOW - 1_000,
      }),
    )
    expect(await service.getCachedZkProof(DEFAULTS.caller, DEFAULTS.commitment)).toBeNull()
    expect(await storage.hasAnyProof()).toBe(false)
  })
})

describe("ZkJwtService.pruneExpiredProofs", () => {
  it("evicts durably-invalid bundles and retains valid ones", async () => {
    const { service, storage } = build()
    // Fresh bundle (valid)
    await storage.saveProofCache(
      ["pFresh"],
      ["v"],
      publicInputs(),
      makeMetadata({ commitment: "0xFRESH", cachedAt: NOW - 1_000 }),
    )
    // Stale bundle (iat expired)
    await storage.saveProofCache(
      ["pStale"],
      ["v"],
      publicInputs(),
      makeMetadata({
        commitment: "0xSTALE",
        iat: Math.floor((NOW - ONE_WEEK_MS - 1_000) / 1000),
        cachedAt: NOW - 1_000,
      }),
    )
    await service.pruneExpiredProofs()
    const remaining = await storage.listProofs()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.metadata.commitment).toBe("0xFRESH")
  })

  it("does not evict on caller mismatch (other callers' bundles stay valid)", async () => {
    const { service, storage } = build()
    await storage.saveProofCache(
      ["p"],
      ["v"],
      publicInputs(),
      makeMetadata({ callerAddress: "0xOTHER", cachedAt: NOW - 1_000 }),
    )
    await service.pruneExpiredProofs()
    expect(await storage.hasAnyProof()).toBe(true)
  })

  it("evicts registry-rejected bundles", async () => {
    const jwkMock = vi.fn(async () => false)
    const audMock = vi.fn(async () => true)
    const { service, storage } = build({
      registry: { isValidJwk: jwkMock, isAudAllowed: audMock },
    })
    await storage.saveProofCache(
      ["p"],
      ["v"],
      publicInputs(),
      makeMetadata({ cachedAt: NOW - 1_000 }),
    )
    await service.pruneExpiredProofs()
    expect(await storage.hasAnyProof()).toBe(false)
  })

  it("retains bundles on transient registry errors", async () => {
    const jwkMock = vi.fn(async () => {
      throw new Error("network blip")
    })
    const audMock = vi.fn(async () => true)
    const { service, storage } = build({
      registry: { isValidJwk: jwkMock, isAudAllowed: audMock },
    })
    await storage.saveProofCache(
      ["p"],
      ["v"],
      publicInputs(),
      makeMetadata({ cachedAt: NOW - 1_000 }),
    )
    await service.pruneExpiredProofs()
    expect(await storage.hasAnyProof()).toBe(true)
  })
})

describe("ZkJwtService.runProving / proveInBackground", () => {
  it("populates metadata.audHash from publicInputs[3]", async () => {
    const customAud = "0xAUD_FROM_PROOF"
    const { service, storage, proveMock } = build()
    proveMock.mockResolvedValueOnce(
      makeProverResult({
        publicInputs: [
          DEFAULTS.caller,
          DEFAULTS.emailHash,
          DEFAULTS.commitment,
          customAud,
          "0x" + DEFAULTS.iat.toString(16),
          DEFAULTS.jwkId,
          DEFAULTS.issHash,
        ],
      } as Partial<ZkJwtProofResult>),
    )
    service.proveInBackground("jwt", "google", 0n, DEFAULTS.caller)
    await service.waitForProof()
    const bundle = await storage.getProof(DEFAULTS.commitment)
    expect(bundle).not.toBeNull()
    expect(bundle!.metadata.audHash).toBe(customAud)
    expect(bundle!.metadata.jwkId).toBe("0xJWK")
    expect(bundle!.metadata.email).toBe("alice@example.com")
    expect(service.isCached).toBe(true)
  })

  it("sets state to 'error' and fires onError when the prover throws", async () => {
    const { service, proveMock } = build()
    proveMock.mockRejectedValueOnce(new Error("boom"))
    const onError = vi.fn()
    service.proveInBackground("jwt", "google", 0n, DEFAULTS.caller, { onError })
    await service.waitForProof()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error)
    expect(service.state).toBe("error")
  })

  it("is a no-op while a prior proving pass is in flight", async () => {
    const { service, proveMock } = build()
    let release: (() => void) | null = null
    proveMock.mockImplementationOnce(
      () =>
        new Promise<ZkJwtProofResult>((resolve) => {
          release = () => resolve(makeProverResult())
        }),
    )
    service.proveInBackground("jwt", "google", 0n, DEFAULTS.caller)
    expect(service.isProving).toBe(true)
    // Pump microtasks until runProving reaches the awaited prover.prove() call
    while (!release) {
      await Promise.resolve()
    }
    expect(proveMock).toHaveBeenCalledTimes(1)
    // A second invocation while proving must not kick off a second run
    service.proveInBackground("jwt", "google", 0n, DEFAULTS.caller)
    await Promise.resolve()
    expect(proveMock).toHaveBeenCalledTimes(1)
    // TS does not narrow `release` after the loop (assignment is inside the Promise executor).
    const finishProve = release as () => void
    finishProve()
    await service.waitForProof()
    expect(proveMock).toHaveBeenCalledTimes(1)
  })
})

describe("ZkJwtService.checkAndRecoverProving", () => {
  it("flips 'proving' state back to 'idle' and returns true", async () => {
    const { service, storage } = build()
    await storage.setState("proving")
    const recovered = await service.checkAndRecoverProving()
    expect(recovered).toBe(true)
    expect(await storage.getState()).toBe("idle")
    expect(service.state).toBe("idle")
  })

  it("leaves 'cached' state alone and returns false", async () => {
    const { service, storage } = build()
    await storage.setState("cached")
    const recovered = await service.checkAndRecoverProving()
    expect(recovered).toBe(false)
    expect(await storage.getState()).toBe("cached")
    expect(service.state).toBe("cached")
  })

  it("leaves 'idle' state alone and returns false", async () => {
    const { service, storage } = build()
    const recovered = await service.checkAndRecoverProving()
    expect(recovered).toBe(false)
    expect(await storage.getState()).toBe("idle")
  })
})

describe("ZkJwtService.reset", () => {
  it("clears persisted proofs and state", async () => {
    const { service, storage } = build()
    await storage.saveProofCache(
      ["p"],
      ["v"],
      publicInputs(),
      makeMetadata({ cachedAt: NOW - 1_000 }),
    )
    await storage.setState("cached")
    await service.reset()
    expect(await storage.getState()).toBe("idle")
    expect(await storage.listProofs()).toEqual([])
    expect(service.state).toBe("idle")
  })
})

describe("ZkJwtService registry pre-check", () => {
  async function seedValidBundle(
    storage: ZkJwtStorage,
    over: Partial<Parameters<typeof makeMetadata>[0]> = {},
  ) {
    await storage.saveProofCache(
      ["p"],
      ["v"],
      publicInputs(),
      makeMetadata({ cachedAt: NOW - 1_000, ...over }),
    )
  }

  describe("matchProofForPaylink", () => {
    it("returns proof and consults registry once when jwk + aud are valid", async () => {
      const { registry, jwkMock, audMock } = makeRegistry()
      const { service, storage } = build({ registry })
      await seedValidBundle(storage)

      const result = await service.matchProofForPaylink(
        DEFAULTS.caller,
        "paylinkEmail",
        DEFAULTS.commitment,
      )
      expect(result).not.toBeNull()
      expect(jwkMock).toHaveBeenCalledTimes(1)
      expect(jwkMock).toHaveBeenCalledWith(DEFAULTS.jwkId, DEFAULTS.issHash)
      expect(audMock).toHaveBeenCalledTimes(1)
      expect(audMock).toHaveBeenCalledWith(DEFAULTS.audHash)
      expect(await storage.hasAnyProof()).toBe(true)
    })

    it("evicts and returns null when jwk is no longer allowlisted", async () => {
      const jwkMock = vi.fn(async () => false)
      const audMock = vi.fn(async () => true)
      const { service, storage } = build({
        registry: { isValidJwk: jwkMock, isAudAllowed: audMock },
      })
      await seedValidBundle(storage)
      await storage.setState("cached")

      const result = await service.matchProofForPaylink(
        DEFAULTS.caller,
        "paylinkEmail",
        DEFAULTS.commitment,
      )
      expect(result).toBeNull()
      expect(jwkMock).toHaveBeenCalledTimes(1)
      // Both lookups fire concurrently — aud is not skipped.
      expect(audMock).toHaveBeenCalledTimes(1)
      expect(await storage.hasAnyProof()).toBe(false)
      expect(await storage.getState()).toBe("idle")
      expect(service.state).toBe("idle")
    })

    it("evicts and returns null when aud is no longer allowlisted", async () => {
      const jwkMock = vi.fn(async () => true)
      const audMock = vi.fn(async () => false)
      const { service, storage } = build({
        registry: { isValidJwk: jwkMock, isAudAllowed: audMock },
      })
      await seedValidBundle(storage)
      await storage.setState("cached")

      const result = await service.matchProofForPaylink(
        DEFAULTS.caller,
        "paylinkEmail",
        DEFAULTS.commitment,
      )
      expect(result).toBeNull()
      expect(jwkMock).toHaveBeenCalledTimes(1)
      expect(audMock).toHaveBeenCalledTimes(1)
      expect(await storage.hasAnyProof()).toBe(false)
      expect(await storage.getState()).toBe("idle")
    })

    it("evicts and returns null when both jwk and aud are invalid", async () => {
      const jwkMock = vi.fn(async () => false)
      const audMock = vi.fn(async () => false)
      const { service, storage } = build({
        registry: { isValidJwk: jwkMock, isAudAllowed: audMock },
      })
      await seedValidBundle(storage)

      const result = await service.matchProofForPaylink(
        DEFAULTS.caller,
        "paylinkEmail",
        DEFAULTS.commitment,
      )
      expect(result).toBeNull()
      expect(await storage.hasAnyProof()).toBe(false)
    })

    it("retains the bundle when isValidJwk throws (transient RPC error)", async () => {
      const jwkMock = vi.fn(async () => {
        throw new Error("network blip")
      })
      const audMock = vi.fn(async () => true)
      const { service, storage } = build({
        registry: { isValidJwk: jwkMock, isAudAllowed: audMock },
      })
      await seedValidBundle(storage)
      await storage.setState("cached")

      const result = await service.matchProofForPaylink(
        DEFAULTS.caller,
        "paylinkEmail",
        DEFAULTS.commitment,
      )
      expect(result).toBeNull()
      expect(await storage.hasAnyProof()).toBe(true) // retained
      expect(await storage.getState()).toBe("cached") // unchanged
    })

    it("retains the bundle when isAudAllowed throws (transient RPC error)", async () => {
      const jwkMock = vi.fn(async () => true)
      const audMock = vi.fn(async () => {
        throw new Error("network blip")
      })
      const { service, storage } = build({
        registry: { isValidJwk: jwkMock, isAudAllowed: audMock },
      })
      await seedValidBundle(storage)
      await storage.setState("cached")

      const result = await service.matchProofForPaylink(
        DEFAULTS.caller,
        "paylinkEmail",
        DEFAULTS.commitment,
      )
      expect(result).toBeNull()
      expect(await storage.hasAnyProof()).toBe(true)
      expect(await storage.getState()).toBe("cached")
    })

    it("skips registry entirely for non-paylinkEmail paylinks", async () => {
      const { registry, jwkMock, audMock } = makeRegistry()
      const { service, storage } = build({ registry })
      await seedValidBundle(storage)

      const result = await service.matchProofForPaylink(
        DEFAULTS.caller,
        "paylinkDirect",
        DEFAULTS.commitment,
      )
      expect(result).toBeNull()
      expect(jwkMock).not.toHaveBeenCalled()
      expect(audMock).not.toHaveBeenCalled()
    })

    it("skips registry when local checks already failed (caller mismatch)", async () => {
      const { registry, jwkMock, audMock } = makeRegistry()
      const { service, storage } = build({ registry })
      await storage.saveProofCache(
        ["p"],
        ["v"],
        publicInputs(),
        makeMetadata({ callerAddress: "0xOTHER", cachedAt: NOW - 1_000 }),
      )
      const result = await service.matchProofForPaylink(
        DEFAULTS.caller,
        "paylinkEmail",
        DEFAULTS.commitment,
      )
      expect(result).toBeNull()
      expect(jwkMock).not.toHaveBeenCalled()
      expect(audMock).not.toHaveBeenCalled()
    })

    it("skips registry when local checks already failed (iat expired)", async () => {
      const { registry, jwkMock } = makeRegistry()
      const { service, storage } = build({ registry })
      await storage.saveProofCache(
        ["p"],
        ["v"],
        publicInputs(),
        makeMetadata({
          iat: Math.floor((NOW - ONE_WEEK_MS - 1_000) / 1000),
          cachedAt: NOW - 1_000,
        }),
      )
      const result = await service.matchProofForPaylink(
        DEFAULTS.caller,
        "paylinkEmail",
        DEFAULTS.commitment,
      )
      expect(result).toBeNull()
      expect(jwkMock).not.toHaveBeenCalled()
    })
  })

  describe("pruneExpiredProofs", () => {
    it("evicts bundles whose jwk_id is no longer allowlisted, keeps valid ones", async () => {
      const jwkMock = vi.fn(async (id: string) => id === "0xJWK_B")
      const audMock = vi.fn(async () => true)
      const { service, storage } = build({
        registry: { isValidJwk: jwkMock, isAudAllowed: audMock },
      })
      await storage.saveProofCache(
        ["pA"],
        ["vA"],
        publicInputs(),
        makeMetadata({
          commitment: "0xA",
          jwkId: "0xJWK_A",
          cachedAt: NOW - 2_000,
        }),
      )
      await storage.saveProofCache(
        ["pB"],
        ["vB"],
        publicInputs(),
        makeMetadata({
          commitment: "0xB",
          jwkId: "0xJWK_B",
          cachedAt: NOW - 1_000,
        }),
      )

      await service.pruneExpiredProofs()
      const remaining = await storage.listProofs()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.metadata.commitment).toBe("0xB")
    })
  })

  describe("getCachedZkProof", () => {
    it("flips state to 'idle' after evicting the last cached proof", async () => {
      const jwkMock = vi.fn(async () => false)
      const audMock = vi.fn(async () => true)
      const { service, storage } = build({
        registry: { isValidJwk: jwkMock, isAudAllowed: audMock },
      })
      await storage.saveProofCache(
        ["p"],
        ["v"],
        publicInputs(),
        makeMetadata({ cachedAt: NOW - 1_000 }),
      )
      await storage.setState("cached")

      const proof = await service.getCachedZkProof(DEFAULTS.caller, DEFAULTS.commitment)
      expect(proof).toBeNull()
      expect(await storage.hasAnyProof()).toBe(false)
      expect(await storage.getState()).toBe("idle")
      expect(service.state).toBe("idle")
    })
  })

  describe("no registry configured", () => {
    it("falls back to local-only validation when no registry was injected", async () => {
      // Backward-compat: ZkJwtService remains usable without a registry
      const { service, storage } = build({})
      await storage.saveProofCache(
        ["p"],
        ["v"],
        publicInputs(),
        makeMetadata({ cachedAt: NOW - 1_000 }),
      )
      const result = await service.matchProofForPaylink(
        DEFAULTS.caller,
        "paylinkEmail",
        DEFAULTS.commitment,
      )
      expect(result).not.toBeNull()
    })
  })
})
