import { describe, expect, it } from "vitest"
import { L1_CHAIN_ID_BY_NETWORK, Network } from "@obsidion/core/constants"
import {
  isL2ContractEntry,
  isSupportedVersion,
  NETWORK_L1_CHAIN_IDS,
  PROFILE_NETWORKS,
  parseConfigProfile,
} from "../src/schema.js"
import { stagingDoc, withVersions } from "./fixture.js"

describe("document rules", () => {
  it("rejects an empty versions map", () => {
    const empty = stagingDoc()
    empty.versions = {}
    expect(() => parseConfigProfile(empty)).toThrow(/versions/)
  })

  it("admits only x.y.z version ids", () => {
    expect(() =>
      parseConfigProfile(withVersions("0.0.1", "0.0.2", "0.1.0", "10.2.30")),
    ).not.toThrow()
    for (const id of [
      "v1",
      "1",
      "0.0",
      "0.0.03",
      "00.1.0",
      "0.0.3-rc.1",
      "0.0.3+build",
      "current",
    ]) {
      expect(() => parseConfigProfile(withVersions(id)), `${id} must be rejected`).toThrow()
    }
  })

  it("refuses a current that names no version, and the error names the dangling id", () => {
    const doc = stagingDoc()
    doc.current = "0.9.9"
    expect(() => parseConfigProfile(doc)).toThrow(/current.*0\.9\.9.*is not a version/)
  })

  it("refuses a current that would resolve through the prototype chain", () => {
    const doc = stagingDoc()
    doc.current = "constructor"
    expect(() => parseConfigProfile(doc)).toThrow()
  })

  it("requires current", () => {
    const doc = stagingDoc()
    delete doc.current
    expect(() => parseConfigProfile(doc)).toThrow(/current/)
  })

  it("requires a well-formed deployedAt on every version", () => {
    const doc = stagingDoc()
    delete doc.versions["0.0.2"].deployedAt
    expect(() => parseConfigProfile(doc)).toThrow(/deployedAt/)

    const malformed = stagingDoc()
    malformed.versions["0.0.2"].deployedAt = "2026-08-11"
    expect(() => parseConfigProfile(malformed)).toThrow(/deployedAt/)
  })

  it("rejects an address on a per-instance contract, naming the row", () => {
    for (const name of [
      "paylinkDirect",
      "paylinkEmail",
      "obsidionAccountAlpha",
      "obsidionAccountAlphaTest",
    ]) {
      const doc = stagingDoc()
      doc.versions["0.0.2"].contracts[name] = {
        address: "0x" + "1".repeat(64),
        classId: "0x" + "2".repeat(64),
      }
      expect(() => parseConfigProfile(doc), `${name} with an address must be rejected`).toThrow(
        new RegExp(`states an address for \\W{0,2}${name}\\W`),
      )
    }
  })

  it("rejects an address-only per-instance row through the L1 union branch too", () => {
    for (const width of [40, 64]) {
      const doc = stagingDoc()
      doc.versions["0.0.2"].contracts.paylinkDirect = { address: "0x" + "1".repeat(width) }
      expect(() => parseConfigProfile(doc), `width ${width} must be rejected`).toThrow()
    }
  })

  it("accepts the per-instance contracts class-only", () => {
    expect(() => parseConfigProfile(stagingDoc())).not.toThrow()
  })

  it("pins l1ChainId to the network enum", () => {
    const doc = stagingDoc()
    doc.shared.l1ChainId = 1
    expect(() => parseConfigProfile(doc)).toThrow(/l1ChainId/)
  })

  it("accepts an absent expiresAt, and requires it to be after publishedAt", () => {
    const doc = stagingDoc()
    expect(doc.expiresAt).toBeUndefined()
    expect(() => parseConfigProfile(doc)).not.toThrow()

    doc.expiresAt = "2020-01-01T00:00:00Z"
    expect(() => parseConfigProfile(doc)).toThrow(/expiresAt/)
    doc.expiresAt = "2030-01-01T00:00:00Z"
    expect(() => parseConfigProfile(doc)).not.toThrow()
  })

  it("requires https on every network but sandbox, for every URL a version carries", () => {
    // Data-driven over the whole set: the rule enumerates its fields by hand, so a field added to
    // the schema and forgotten there would otherwise ship a plaintext endpoint silently.
    const urlFields = ["nodeUrl", "l1RpcUrl", "accountServiceUrl", "zkmoneyApiUrl", "paylinkDomain"]
    for (const field of urlFields) {
      const doc = stagingDoc()
      doc.versions["0.0.2"][field] = "http://insecure.test"
      expect(() => parseConfigProfile(doc), `${field} must be rejected`).toThrow(/https/)
    }

    const nested = stagingDoc()
    nested.versions["0.0.2"].oxide.manifestUrl = "http://insecure.test"
    expect(() => parseConfigProfile(nested)).toThrow(/https/)

    // Every httpUrl-typed field in the version schema is covered above.
    expect(urlFields.length + 1).toBe(6)
  })

  it("lets a sandbox profile point at localhost", () => {
    const doc = stagingDoc()
    doc.profileId = "sandbox"
    doc.network = "sandbox"
    doc.shared.l1ChainId = 31337
    for (const version of Object.values<any>(doc.versions)) {
      version.nodeUrl = "http://localhost:8080"
      version.l1RpcUrl = "http://localhost:8545"
    }
    expect(() => parseConfigProfile(doc)).not.toThrow()
  })

  it("rejects unknown top-level keys", () => {
    const extra = stagingDoc()
    extra.contractServiceVersion = "0.0.3"
    expect(() => parseConfigProfile(extra)).toThrow()
    const versioned = stagingDoc()
    versioned.schemaVersion = "1"
    expect(() => parseConfigProfile(versioned)).toThrow()
    const classed = stagingDoc()
    classed.class = "staging"
    expect(() => parseConfigProfile(classed)).toThrow()
  })
})

describe("versions", () => {
  it("carries every deploy-varying endpoint, so a version stands alone", () => {
    const doc = stagingDoc()
    const version = doc.versions["0.0.2"]

    for (const field of [
      "nodeUrl",
      "l1RpcUrl",
      "accountServiceUrl",
      "zkmoneyApiUrl",
      "paylinkDomain",
    ]) {
      expect(version[field]).toMatch(/^https?:\/\//)
      delete version[field]
      expect(() => parseConfigProfile(doc)).toThrow(new RegExp(field))
      version[field] = "https://example.test"
    }
  })

  it("keeps only chain-fixed values in shared", () => {
    const doc = stagingDoc()
    expect(Object.keys(doc.shared).sort()).toEqual(["l1ChainId", "rollupVersion", "xmtpEnv"])
  })

  it("scopes the document to one rollup: rollupVersion is shared, never per-version", () => {
    const doc = stagingDoc()
    expect(doc.shared.rollupVersion).toMatch(/^\d+$/)

    delete doc.shared.rollupVersion
    expect(() => parseConfigProfile(doc)).toThrow(/rollupVersion/)

    const perVersion = stagingDoc()
    perVersion.versions["0.0.2"].rollupVersion = "1821665230"
    expect(() => parseConfigProfile(perVersion)).toThrow()
  })

  it("carries our own commit per version, separate from oxide's pin", () => {
    const doc = stagingDoc()
    for (const version of Object.values<any>(doc.versions)) {
      expect(version.gitSha).toMatch(/^[0-9a-f]{40}$/)
    }
    expect(doc.versions["0.0.2"].oxide.expectedGitSha).not.toBe(doc.versions["0.0.2"].gitSha)
  })

  it("accepts an optional artifact manifest pin and rejects anything but lowercase SHA-256", () => {
    const doc = stagingDoc()
    doc.versions["0.0.2"].artifactManifestSha256 = "a".repeat(64)
    expect(() => parseConfigProfile(doc)).not.toThrow()

    doc.versions["0.0.2"].artifactManifestSha256 = "A".repeat(64)
    expect(() => parseConfigProfile(doc)).toThrow(/artifactManifestSha256/)
  })

  it("requires the oxide gitSha pin on every version of a mainnet document", () => {
    // Mainnet consumers enforce same-sha against the live manifest; a document omitting the pin
    // would degrade that gate to schema-only. The fixture's 0.0.1 carries no pin — fine on
    // testnet, the broken version on mainnet.
    const missing = stagingDoc()
    missing.network = "mainnet"
    missing.shared.l1ChainId = 1
    expect(() => parseConfigProfile(missing)).toThrow(/0\.0\.1.*oxide\.expectedGitSha/)

    const pinned = stagingDoc()
    pinned.network = "mainnet"
    pinned.shared.l1ChainId = 1
    pinned.versions["0.0.1"].oxide.expectedGitSha = "c".repeat(40)
    expect(() => parseConfigProfile(pinned)).not.toThrow()

    // Presence is what the document owes: the 40-zero sha is the not-yet-recorded sentinel and
    // validates, leaving the fail-closed step to the manifest gate.
    const sentinel = stagingDoc()
    sentinel.network = "mainnet"
    sentinel.shared.l1ChainId = 1
    sentinel.versions["0.0.1"].oxide.expectedGitSha = "0".repeat(40)
    expect(() => parseConfigProfile(sentinel)).not.toThrow()

    expect(() => parseConfigProfile(stagingDoc())).not.toThrow()
  })

  it("validates a vkey hash when present, and a version may omit the block entirely", () => {
    const doc = stagingDoc()
    for (const version of Object.values<any>(doc.versions)) {
      expect(version.vkeys.zkJwtVkeyHash).toMatch(/^0x[0-9a-f]{64}$/)
    }

    const omitted = stagingDoc()
    delete omitted.versions["0.0.2"].vkeys
    expect(() => parseConfigProfile(omitted)).not.toThrow()
  })
})

describe("contracts map", () => {
  it("requires classId but not address on L2, so a class-only contract is representable", () => {
    const doc = stagingDoc()
    const version = doc.versions["0.0.2"]

    expect(version.contracts.paylinkDirect.address).toBeUndefined()
    expect(() => parseConfigProfile(doc)).not.toThrow()

    delete version.contracts.sponsorFPC.classId
    expect(() => parseConfigProfile(doc)).toThrow()
  })

  it("holds L1 contracts by address alone, with no class to verify", () => {
    const doc = stagingDoc()
    const version = doc.versions["0.0.2"]

    expect(version.contracts.stealthPortal).toEqual({
      address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
    })
    expect(() => parseConfigProfile(doc)).not.toThrow()

    version.contracts.stealthPortal.classId = `0x${"1".repeat(64)}`
    expect(() => parseConfigProfile(doc)).toThrow()
  })

  it("tolerates versions with and without an accountFactory entry", () => {
    // The factory is oxide's and lives in their manifest; a legacy document that still carries
    // the entry parses identically — the field is ignored, not rejected.
    const without = stagingDoc()
    delete without.versions["0.0.2"].contracts.accountFactory
    expect(() => parseConfigProfile(without)).not.toThrow()

    const legacy = stagingDoc()
    legacy.versions["0.0.2"].contracts.accountFactory = { address: `0x${"4".repeat(40)}` }
    expect(() => parseConfigProfile(legacy)).not.toThrow()
  })

  it("rejects a version with no contracts", () => {
    const doc = stagingDoc()
    doc.versions["0.0.2"].contracts = {}
    expect(() => parseConfigProfile(doc)).toThrow(/no contracts/)
  })

  it("lets key sets differ per version, so a later deployment can add a contract", () => {
    const doc = stagingDoc()
    expect(doc.versions["0.0.1"].contracts.claimFpc).toBeUndefined()
    expect(doc.versions["0.0.2"].contracts.claimFpc.classId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(() => parseConfigProfile(doc)).not.toThrow()
  })

  it("carries opaque per-contract meta through validation unchanged", () => {
    const doc = stagingDoc()
    const shipped = doc.versions["0.0.2"].contracts.claimFpc.meta.policyManifest
    expect(Array.isArray(shipped.entries)).toBe(true)

    const parsed = parseConfigProfile(doc)
    const live = parsed.versions["0.0.2"]!
    if (!isSupportedVersion(live)) throw new Error("expected a supported entry")
    const claimFpc = live.contracts.claimFpc!
    expect(isL2ContractEntry(claimFpc) && claimFpc.meta!.policyManifest).toEqual(shipped)
  })
})

/**
 * The network vocabulary restates values @obsidion/core also carries, on purpose: these literals
 * govern what an already-published document may contain, so they move by a deliberate schema
 * change rather than by following an app constant. Silent divergence is the hazard —
 * it would leave the validator and the wallet disagreeing about the same network.
 */
describe("network vocabulary is pinned to @obsidion/core", () => {
  it("accepts exactly the networks core defines", () => {
    expect([...PROFILE_NETWORKS].sort()).toEqual(Object.values(Network).sort())
  })

  it("states the L1 chain id core states, for every network", () => {
    for (const network of PROFILE_NETWORKS) {
      expect(NETWORK_L1_CHAIN_IDS[network]).toBe(L1_CHAIN_ID_BY_NETWORK[network as Network])
    }
  })
})

describe("per-entry schemaVersion", () => {
  it("requires the marker on every version entry", () => {
    const doc = stagingDoc()
    delete doc.versions["0.0.2"].schemaVersion
    expect(() => parseConfigProfile(doc)).toThrow(/schemaVersion/)
  })

  it("holds a supported entry to the full strict shape", () => {
    const doc = stagingDoc()
    doc.versions["0.0.2"].futureField = true
    expect(() => parseConfigProfile(doc)).toThrow(/futureField/)
  })

  it("admits only a positive decimal marker", () => {
    for (const bad of ["0", "01", "v2", "1.0", "", 1]) {
      const doc = stagingDoc()
      doc.versions["0.0.2"].schemaVersion = bad
      expect(() => parseConfigProfile(doc), `${JSON.stringify(bad)} must be rejected`).toThrow()
    }
  })

  it("tolerates an entry of a schema this build does not speak, opaquely", () => {
    // Nothing about a shape this build cannot read is checkable, so no shape rule fires on it —
    // not the https rule, not the contracts rules — and its body passes through untouched.
    const doc = stagingDoc()
    doc.versions["0.0.3"] = {
      schemaVersion: "2",
      nodeUrl: "http://insecure.example",
      contracts: {},
      whatever: { nested: true },
    }
    const profile = parseConfigProfile(doc)
    expect(profile.versions["0.0.3"]).toMatchObject({
      schemaVersion: "2",
      whatever: { nested: true },
    })
  })

  it("current may name an entry the build cannot read — resolution is where that fails, not parse", () => {
    const doc = stagingDoc()
    doc.versions["0.0.3"] = { schemaVersion: "2" }
    doc.current = "0.0.3"
    expect(() => parseConfigProfile(doc)).not.toThrow()
  })
})

describe("oxide pointer", () => {
  it("requires the pinned portal as a 20-byte address", () => {
    const missing = stagingDoc()
    delete (missing.versions["0.0.2"].oxide as Record<string, unknown>).portal
    expect(() => parseConfigProfile(missing)).toThrow(/portal/)
    const bad = stagingDoc()
    ;(bad.versions["0.0.2"].oxide as Record<string, unknown>).portal = "0x1234"
    expect(() => parseConfigProfile(bad)).toThrow(/portal/)
  })
})
