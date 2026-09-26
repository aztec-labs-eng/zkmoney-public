import { describe, expect, it } from "vitest"
import type { GenerationManifestEntry } from "@obsidion/core/types"
import {
  canonicalGenerationStack,
  detectGenerations,
  generationStorePrefix,
  isFrozenGenerationVersion,
  legacyStoreBaseName,
  migrationCtaState,
  prePrefixLineageVersion,
} from "../../src/index.js"

const MANIFEST: readonly GenerationManifestEntry[] = [
  {
    version: 4,
    status: "frozen",
    nodeUrl: "http://localhost:8080",
    portalAddress: "0x1111111111111111111111111111111111111111",
    erc20Address: "0x2222222222222222222222222222222222222222",
    bundleAsset: "exit-v4",
  },
  { version: 5, status: "canonical" },
]

const opts = (overrides: {
  onChain: number
  hasState?: (g: GenerationManifestEntry) => Promise<boolean>
}) => ({
  nodeUrl: "http://node.test",
  generations: MANIFEST,
  getRollupVersion: async () => overrides.onChain,
  hasLocalState: overrides.hasState ?? (async () => false),
})

describe("detectGenerations", () => {
  it("pre-cutover: node reports v4 → v4 canonical, v5 dormant (not migratable)", async () => {
    const d = await detectGenerations(opts({ onChain: 4 }))
    expect(d.canonical?.version).toBe(4)
    expect(d.unsupported).toBe(false)
    // v5 is frozen-relative-to-detection but holds no local state → not migratable
    expect(d.migratable).toEqual([])
  })

  it("post-cutover: node reports v5 → v5 canonical; v4 migratable iff its store holds notes", async () => {
    const withNotes = await detectGenerations(
      opts({ onChain: 5, hasState: async (g) => g.version === 4 }),
    )
    expect(withNotes.canonical?.version).toBe(5)
    expect(withNotes.migratable.map((g) => g.version)).toEqual([4])

    const withoutNotes = await detectGenerations(opts({ onChain: 5 }))
    expect(withoutNotes.migratable).toEqual([])
  })

  it("canonicity is chain-derived, not the manifest's static status", async () => {
    // manifest says v4=frozen/v5=canonical, but the chain still reports 4:
    // detection must say v4 is canonical NOW (pre-cutover binary).
    const d = await detectGenerations(opts({ onChain: 4 }))
    expect(d.canonical?.status).toBe("frozen") // static hint disagrees — chain wins
    expect(d.canonical?.version).toBe(4)
  })

  it("unknown on-chain version → unsupported, not a crash", async () => {
    const d = await detectGenerations(opts({ onChain: 6 }))
    expect(d.canonical).toBeNull()
    expect(d.unsupported).toBe(true)
    // both embedded generations are frozen relative to an unknown canonical
    expect(d.migratable).toEqual([])
  })

  it("a failing store probe means unknown, never migratable", async () => {
    const d = await detectGenerations(
      opts({
        onChain: 5,
        hasState: async () => {
          throw new Error("store locked")
        },
      }),
    )
    expect(d.migratable).toEqual([])
    // the frozen v4 probe threw → captured as probeFailed, not silently dropped
    expect(d.probeFailed.map((g) => g.version)).toEqual([4])
  })

  it("rejects a node version the registry cross-check disagrees with (spoof guard)", async () => {
    const d = await detectGenerations({
      ...opts({ onChain: 5 }),
      verifyCanonical: async () => false,
    })
    expect(d.spoofRejected).toBe(true)
    expect(d.canonical).toBeNull()
    expect(d.unsupported).toBe(true)
  })

  it("accepts the version when the cross-check agrees", async () => {
    const d = await detectGenerations({
      ...opts({ onChain: 5 }),
      verifyCanonical: async () => true,
    })
    expect(d.spoofRejected).toBe(false)
    expect(d.canonical?.version).toBe(5)
  })
})

describe("isFrozenGenerationVersion", () => {
  it("is true only for a manifest-listed frozen version", () => {
    expect(isFrozenGenerationVersion(4, MANIFEST)).toBe(true)
    expect(isFrozenGenerationVersion(5, MANIFEST)).toBe(false)
    // unknown (sandbox / preview) versions are not a freeze
    expect(isFrozenGenerationVersion(6, MANIFEST)).toBe(false)
  })
})

describe("canonicalGenerationStack", () => {
  it("comes from the canonical entry (defaults v5)", () => {
    expect(canonicalGenerationStack([{ version: 4, status: "canonical", stack: "v4" }])).toBe("v4")
    expect(canonicalGenerationStack([{ version: 5, status: "canonical", stack: "v5" }])).toBe("v5")
    expect(canonicalGenerationStack([{ version: 5, status: "canonical" }])).toBe("v5")
  })
})

describe("migrationCtaState", () => {
  const base = { onChainVersion: 5, canonical: null, unsupported: false, spoofRejected: false }
  const frozen: GenerationManifestEntry = { version: 4, status: "frozen" }

  it("has-migratable when a frozen balance exists", () => {
    expect(migrationCtaState({ ...base, migratable: [frozen], probeFailed: [] })).toBe(
      "has-migratable",
    )
  })

  it("unknown when a probe failed and nothing is confirmed migratable", () => {
    expect(migrationCtaState({ ...base, migratable: [], probeFailed: [frozen] })).toBe("unknown")
  })

  it("none when there is genuinely nothing to migrate", () => {
    expect(migrationCtaState({ ...base, migratable: [], probeFailed: [] })).toBe("none")
  })
})

describe("generationStorePrefix", () => {
  it("keys stores by generation×network", () => {
    expect(generationStorePrefix(4, "testnet")).toBe("v4_testnet")
    expect(generationStorePrefix(5, "sandbox")).toBe("v5_sandbox")
  })
})

describe("prePrefixLineageVersion", () => {
  it("post-cutover manifest (frozen v4 + canonical v5) → the frozen entry", () => {
    expect(prePrefixLineageVersion(MANIFEST)).toBe(4)
  })

  it("pre-cutover manifest (canonical only) → canonical, matching today's adoption", () => {
    const preCutover: readonly GenerationManifestEntry[] = [{ version: 4, status: "canonical" }]
    expect(prePrefixLineageVersion(preCutover)).toBe(4)
  })

  it("two frozen generations → still the oldest (first) entry, never a later frozen one", () => {
    const twoFrozen: readonly GenerationManifestEntry[] = [
      { version: 4, status: "frozen" },
      { version: 5, status: "frozen" },
      { version: 6, status: "canonical" },
    ]
    expect(prePrefixLineageVersion(twoFrozen)).toBe(4)
  })

  it("empty manifest → throws", () => {
    expect(() => prePrefixLineageVersion([])).toThrow()
  })
})

describe("legacyStoreBaseName", () => {
  it("is the unprefixed pre-generation store name", () => {
    expect(legacyStoreBaseName("sandbox")).toBe("sandbox_pxe_data")
  })
})
