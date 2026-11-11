/**
 * The tag→nameHash match surfaces: the entry-path pair (`tagMatches`/`confirmTag`) and the
 * production detection resolver, which must delegate to the shared matcher rather than a local
 * comparison. A tag hashes folded, so every one of them answers in the folded form whatever
 * casing the caller arrived with.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { composeWireNameHash } from "@obsidion/front-core"

import {
  confirmTag,
  reservedTagMatch,
  tagMatches,
  type EnteredClaim,
} from "../../../../src/features/onboarding/oxideOnboarding"
import { resolveLocalTag } from "../../../../src/features/registration/webRegistration"
import { answered } from "../../../support/query"

const DOMAIN = "oxidestaging.eth"

const reads = { oxideTuple: answered({ ensDomain: DOMAIN }) } as never
vi.mock("../../../../src/config/oxideTuple", () => ({
  requireTupleField: (tuple: Record<string, string>, field: string) => tuple[field],
}))

function claim(handle: string): EnteredClaim {
  return {
    nameHash: composeWireNameHash(handle, DOMAIN).toLowerCase() as EnteredClaim["nameHash"],
    address: "0x" + "11".repeat(32),
    ensDomain: DOMAIN,
  }
}

describe("tagMatches / confirmTag", () => {
  it("answers folded however the claim and the handle were cased", () => {
    // A registration cannot be mixed-case: composeWireNameHash folds, so claim("Alice") is
    // the same node as claim("alice") and both reach it as "alice".
    expect(claim("Alice").nameHash).toBe(claim("alice").nameHash)
    for (const handle of ["Alice", "@Alice", "ALICE", "alice"]) {
      expect(tagMatches(claim("Alice"), handle)).toBe("alice")
    }
  })

  it("confirmTag persists the matched form, not the caller's casing", () => {
    // finish() spreads this straight into saveIdentity, so the returned handle is
    // what every later detection tick re-hashes.
    expect(confirmTag(claim("alice"), "Alice")).toEqual({
      handle: "alice",
      address: claim("alice").address,
    })
  })

  it("confirmTag throws on a non-matching handle", () => {
    expect(() => confirmTag(claim("alice"), "bob")).toThrow()
  })
})

describe("reservedTagMatch", () => {
  const hash = (tag: string, domain = DOMAIN) => composeWireNameHash(tag, domain)

  it("names the tag among several claimed hashes, not only the first", () => {
    expect(reservedTagMatch([hash("alice"), hash("cris")], DOMAIN, "cris")).toBe("cris")
  })

  it("accepts the decorated and cased forms a user types", () => {
    for (const typed of ["@Cris", "CRIS", `cris.${DOMAIN}`, "cris.zk.money"]) {
      expect(reservedTagMatch([hash("cris")], DOMAIN, typed)).toBe("cris")
    }
  })

  it("refuses a tag none of the hashes name, and a hash under another wire domain", () => {
    expect(reservedTagMatch([hash("cris")], DOMAIN, "bob")).toBeNull()
    expect(reservedTagMatch([hash("cris", "zk.money")], DOMAIN, "cris")).toBeNull()
    expect(reservedTagMatch([], DOMAIN, "cris")).toBeNull()
  })
})

describe("resolveLocalTag (production detection resolver)", () => {
  const identity = (handle: string) => ({ handle, address: "0x" + "11".repeat(32), claimedAt: 1 })

  it("delegates to the shared matcher: a stored handle resolves folded, whatever its case", async () => {
    const nameHash = composeWireNameHash("Alice", DOMAIN)
    await expect(resolveLocalTag(nameHash, reads, identity("Alice"))).resolves.toBe("alice")
  })

  it("returns null when the stored handle cannot reach the registered node", async () => {
    const otherHash = composeWireNameHash("bob", DOMAIN)
    await expect(resolveLocalTag(otherHash, reads, identity("alice"))).resolves.toBeNull()
  })
})
