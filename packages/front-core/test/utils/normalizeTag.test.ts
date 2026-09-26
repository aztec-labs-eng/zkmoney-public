import { describe, expect, it } from "vitest"
import { MAX_TAG_LENGTH } from "@obsidion/core/constants"
import { normalizeTag } from "../../src/utils/normalizeTag"

describe("normalizeTag", () => {
  it("folds to the bare lowercase form", () => {
    expect(normalizeTag("  @Mary.zk.money ")).toBe("mary")
    expect(normalizeTag("Honk-G00se")).toBe("honk-g00se")
    expect(normalizeTag("ABC")).toBe("abc")
  })

  it("accepts short alphanumerics, a leading underscore run, and hyphenated tags", () => {
    for (const tag of ["x", "a1", "_alice", "___", "honk-goose", "a--bc", "abc--de"]) {
      expect(normalizeTag(tag), tag).toBe(tag)
    }
  })

  it("rejects empty, over-long, and hyphen-edged tags", () => {
    for (const tag of ["", "@.zk.money", "a".repeat(MAX_TAG_LENGTH + 1), "-alice", "alice-"]) {
      expect(normalizeTag(tag), tag).toBeNull()
    }
  })

  it("rejects characters outside the tag charset", () => {
    for (const tag of ["al ice", "al.ice", "al+ice", "alice!", "aliçe", "al/ice"]) {
      expect(normalizeTag(tag), tag).toBeNull()
    }
  })

  /**
   * The two ENSIP-15 rules the charset can still spell. A tag is registered as the
   * `<tag>.<ensDomain>` label and nothing downstream re-checks it, so a leak here lands a claim on
   * a node no ENS client resolves.
   */
  it("rejects an underscore past the leading run", () => {
    for (const tag of ["honk_the_g00se", "bob_", "a_b"]) {
      expect(normalizeTag(tag), tag).toBeNull()
    }
  })

  it("rejects a label extension", () => {
    for (const tag of ["xn--foo", "ab--cd", "he--llo", "0x--ab"]) {
      expect(normalizeTag(tag), tag).toBeNull()
    }
  })

  /** How a wire decoder asks "is this already canonical?" without folding on the caller's behalf. */
  it("round-trips only a tag that is already bare and usable", () => {
    for (const tag of ["alice", "honk-goose", "_alice"]) {
      expect(normalizeTag(tag) === tag, tag).toBe(true)
    }
    for (const tag of ["Alice", "@alice", "alice.zk.money", " alice", "bob_smith"]) {
      expect(normalizeTag(tag) === tag, tag).toBe(false)
    }
  })
})
