import { describe, it, expect } from "vitest"
import { composeWireNameHash, matchWireNameHash } from "../../src/core/services/wireDomain"

// `cast namehash "alice.oxidestaging.eth"` — the byte-exact wire node.
const ALICE_OXIDESTAGING = "0x362ff52ec1322af82c3743567f194601ce6513a0f846f8851a1334e3bdd706cd"

describe("composeWireNameHash", () => {
  it("namehashes <bareTag>.<ensDomain> byte-for-byte", () => {
    expect(composeWireNameHash("alice", "oxidestaging.eth")).toBe(ALICE_OXIDESTAGING)
  })

  it("does not double-append when the tag already carries the wire suffix", () => {
    expect(composeWireNameHash("alice.oxidestaging.eth", "oxidestaging.eth")).toBe(ALICE_OXIDESTAGING)
  })

  it("uses the supplied wire domain, so different domains yield different nodes", () => {
    expect(composeWireNameHash("alice", "oxidestaging.eth")).not.toBe(
      composeWireNameHash("alice", "zk.money"),
    )
  })

  it("folds case, so a tag can only ever register under one node", () => {
    for (const cased of ["Alice", "ALICE", "aLiCe", " Alice ", "Alice.oxidestaging.eth"]) {
      expect(composeWireNameHash(cased, "oxidestaging.eth")).toBe(ALICE_OXIDESTAGING)
    }
  })

  it("rejects an empty tag or empty ensDomain", () => {
    expect(() => composeWireNameHash("", "oxidestaging.eth")).toThrow()
    expect(() => composeWireNameHash("   ", "oxidestaging.eth")).toThrow()
    expect(() => composeWireNameHash("alice", "")).toThrow()
  })
})

const DOMAIN = "oxidestaging.eth"
const REG_LOWER = composeWireNameHash("alice", DOMAIN)

describe("matchWireNameHash", () => {
  it("matches a lowercase registration from a lowercase candidate", () => {
    expect(matchWireNameHash("alice", DOMAIN, REG_LOWER)).toBe("alice")
  })

  it("matches a lowercase registration from a display-cased candidate", () => {
    expect(matchWireNameHash("Alice", DOMAIN, REG_LOWER)).toBe("alice")
  })

  it("strips a leading @ before matching", () => {
    expect(matchWireNameHash("@Alice", DOMAIN, REG_LOWER)).toBe("alice")
    expect(matchWireNameHash("@BOB", DOMAIN, composeWireNameHash("bob", DOMAIN))).toBe("bob")
  })

  it("trims surrounding whitespace and returns the trimmed form", () => {
    expect(matchWireNameHash(" Alice ", DOMAIN, REG_LOWER)).toBe("alice")
  })

  it("strips the wire-domain suffix, returning the bare tag rather than the FQDN", () => {
    expect(matchWireNameHash("Alice.oxidestaging.eth", DOMAIN, REG_LOWER)).toBe("alice")
  })

  it("canonicalizes compound decoration, including a case-folded suffix", () => {
    expect(matchWireNameHash(" @Alice.OXIDESTAGING.ETH ", DOMAIN, REG_LOWER)).toBe("alice")
  })

  it("trims whitespace exposed by suffix stripping", () => {
    expect(matchWireNameHash("Alice .oxidestaging.eth", DOMAIN, REG_LOWER)).toBe("alice")
  })

  it("strips the display suffix independently of the wire domain", () => {
    expect(matchWireNameHash("mary.zk.money", DOMAIN, composeWireNameHash("mary", DOMAIN))).toBe(
      "mary",
    )
  })

  it("compares the hash case-insensitively", () => {
    expect(matchWireNameHash("alice", DOMAIN, REG_LOWER.toUpperCase() as `0x${string}`)).toBe(
      "alice",
    )
  })

  it("returns null for empty and missing candidates without throwing", () => {
    expect(matchWireNameHash("", DOMAIN, REG_LOWER)).toBeNull()
    expect(matchWireNameHash("   ", DOMAIN, REG_LOWER)).toBeNull()
    expect(matchWireNameHash(null, DOMAIN, REG_LOWER)).toBeNull()
    expect(matchWireNameHash(undefined, DOMAIN, REG_LOWER)).toBeNull()
  })

  it("returns null for an unrelated tag", () => {
    expect(matchWireNameHash("bob", DOMAIN, REG_LOWER)).toBeNull()
  })

  it("always returns the folded form, whatever case the candidate carried", () => {
    for (const cased of ["alice", "Alice", "ALICE", "@AlIcE.zk.money"]) {
      expect(matchWireNameHash(cased, DOMAIN, REG_LOWER)).toBe("alice")
    }
  })
})
