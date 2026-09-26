import { describe, expect, it } from "vitest"
import { Network } from "@obsidion/core/constants"
import type { ContractServiceConfig } from "@obsidion/core/types"
import { parseConfigProfile } from "../src/schema.js"
import { toContractServiceConfig } from "../src/toContractServiceConfig.js"
import { ConfigProfileError, resolveVersion } from "../src/client.js"
import { stagingDoc } from "./fixture.js"

const parsed = () => parseConfigProfile(stagingDoc())

describe("toContractServiceConfig", () => {
  it("maps the live version onto the snapshot shape", () => {
    const doc = parsed()
    // Assigning to the core type is the alignment guarantee; typecheck:test is what enforces it.
    const config: ContractServiceConfig = toContractServiceConfig(doc)

    const live = resolveVersion(doc)
    expect(config.network).toBe(Network.TESTNET)
    expect(config.configVersion).toBe(live.versionId)
    expect(config.contracts.oidcKeyRegistry?.address).toBe(
      live.version.contracts.oidcKeyRegistry!.address,
    )
  })

  it("keeps the keys that name a contract and drops keys the wallet has none for", () => {
    const config = toContractServiceConfig(parsed())
    expect(config.contracts.obsidionAccountAlpha?.classId).toMatch(/^0x[0-9a-f]{64}$/)
    // adminAccount is a deploy-side identity, not a wallet contract.
    expect("adminAccount" in config.contracts).toBe(false)
  })

  it("parses a document still spelling the account key the old way, and drops that row", () => {
    // The rollout premise: `contracts` is an open record, so a live document published before the
    // key rename still parses and a build carrying the rename simply ignores the stale row. Safe
    // only while nothing dereferences that class — getConfiguredClassId is called for the two
    // paylink escrows alone. If that stops being true, this test is where it should break.
    const doc = stagingDoc()
    const live = doc.versions[doc.current].contracts
    live.alphaAccount = live.obsidionAccountAlpha
    delete live.obsidionAccountAlpha

    const config = toContractServiceConfig(parseConfigProfile(doc))
    expect("alphaAccount" in config.contracts).toBe(false)
    expect("obsidionAccountAlpha" in config.contracts).toBe(false)
    // The rest of the document is unaffected — one unknown key is dropped, not the map.
    expect(config.contracts.sponsorFPC?.classId).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("takes the new spelling from a document carrying both", () => {
    const doc = stagingDoc()
    const live = doc.versions[doc.current].contracts
    const expected = live.obsidionAccountAlpha.classId
    live.alphaAccount = { classId: "0x" + "9".repeat(64) }

    const config = toContractServiceConfig(parseConfigProfile(doc))
    expect(config.contracts.obsidionAccountAlpha?.classId).toBe(expected)
  })

  it("drops a contract key no ContractName covers", () => {
    const doc = stagingDoc()
    doc.versions["0.0.2"].contracts.somethingLater = { classId: "0x" + "7".repeat(64) }
    const config = toContractServiceConfig(parseConfigProfile(doc))
    expect("somethingLater" in config.contracts).toBe(false)
    expect(config.contracts.sponsorFPC?.classId).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("keeps L1 entries out of the snapshot's contracts map", () => {
    // Two ways an L1 entry could reach the loop: an unmapped name (stealthPortal, from the
    // fixture) and a KNOWN name carrying an L1 shape — only the shape check catches the latter.
    const doc = stagingDoc()
    doc.versions["0.0.2"].contracts.sponsorFPC = {
      address: "0x64196a10ae4ceff9d44b40e254c039e6dd9740e9",
    }
    const config = toContractServiceConfig(parseConfigProfile(doc))
    expect("stealthPortal" in config.contracts).toBe(false)
    expect("sponsorFPC" in config.contracts).toBe(false)
  })

  it("ignores a legacy accountFactory entry — the factory is not this document's", () => {
    const legacy = stagingDoc()
    legacy.versions["0.0.2"].contracts.accountFactory = {
      address: "0x2c5eabc1c0ff859900efbe47a55e8f171d6ac001",
    }
    const config = toContractServiceConfig(parseConfigProfile(legacy))
    expect("accountFactory" in config.contracts).toBe(false)
  })

  it("carries per-contract meta through untouched", () => {
    const raw = stagingDoc()
    const config = toContractServiceConfig(parseConfigProfile(raw))
    expect(config.contracts.claimFpc?.meta?.policyManifest).toEqual(
      raw.versions["0.0.2"].contracts.claimFpc.meta.policyManifest,
    )
  })

  it("keeps a class-only contract addressless rather than inventing an address", () => {
    const config = toContractServiceConfig(parsed())
    expect(config.contracts.paylinkDirect?.classId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(config.contracts.paylinkDirect?.address).toBeUndefined()
  })

  it("omits expectedGitSha when the version's pointer carries none", () => {
    const config = toContractServiceConfig(parsed(), "0.0.1")
    expect(config.oxide?.portal).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect("expectedGitSha" in config.oxide!).toBe(false)
  })

  it("maps a requested version, and rejects one the profile has no entry for", () => {
    const config = toContractServiceConfig(parsed(), "0.0.1")
    expect(config.contracts.claimFpc).toBeUndefined()
    expect(() => toContractServiceConfig(parsed(), "no-such-version")).toThrow(ConfigProfileError)
  })

  it("names the requested version, not the live one", () => {
    const doc = parsed()
    expect(toContractServiceConfig(doc, "0.0.1").configVersion).toBe("0.0.1")
    expect(toContractServiceConfig(doc, "0.0.1").configVersion).not.toBe(doc.current)
  })
})

describe("portal pin", () => {
  it("carries oxide.portal and the manifest URL", () => {
    const config = toContractServiceConfig(parseConfigProfile(stagingDoc()))
    expect(config.oxide?.portal).toBe("0x92308cE04e2416f20b03e941a14F9238C3603334")
    expect(config.oxide?.manifestUrl).toBe("https://manifest.example/staging.v4.json")
  })
})
