// @vitest-environment node
import { describe, expect, it } from "vitest"
import { MAX_TAG_LENGTH } from "@obsidion/core/constants"
import { tagError } from "../../../src/features/registration/tagError"

describe("tagError", () => {
  it("refuses nothing in a usable tag, with or without its @ and domain", () => {
    expect(tagError("alice")).toBeUndefined()
    expect(tagError(" @Alice.zk.money ")).toBeUndefined()
    expect(tagError("_alice-1")).toBeUndefined()
  })

  it("names one distinct reason for each broken rule", () => {
    const broken = [
      "",
      "@.zk.money",
      "a".repeat(MAX_TAG_LENGTH + 1),
      "al!ce",
      "-alice",
      "alice-",
      "al_ice",
      "ab--cd",
    ].map(tagError)
    for (const reason of broken) expect(typeof reason).toBe("string")
    // The empty input and the bare domain break the same rule; leading and trailing hyphens too.
    expect(broken[0]).toBe(broken[1])
    expect(broken[4]).toBe(broken[5])
    const distinct = [broken[0], broken[2], broken[3], broken[4], broken[6], broken[7]]
    expect(new Set(distinct).size).toBe(distinct.length)
  })
})
