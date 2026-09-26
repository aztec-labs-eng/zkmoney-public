import { describe, expect, it } from "vitest"
import type { ContactRow } from "@obsidion/front-core"
import { decimalInput } from "../src/ui/format"
import { parseRequestAmount, recentContacts } from "../src/features/receive/receiveView"

const row = (tag: string, addressKind: ContactRow["addressKind"] = "aztec-l2"): ContactRow => ({
  id: tag,
  name: tag,
  tag,
  address: `0x${tag}`,
  addressKind,
})

describe("recentContacts", () => {
  it("keeps only zk.money contacts", () => {
    const rows = [row("ada"), row("rainbow", "ethereum-l1"), row("bo")]
    expect(recentContacts(rows).map((c) => c.tag)).toEqual(["ada", "bo"])
  })

  it("caps at the limit, in list order", () => {
    const rows = ["a", "b", "c", "d", "e"].map((t) => row(t))
    expect(recentContacts(rows).map((c) => c.tag)).toEqual(["a", "b", "c", "d"])
    expect(recentContacts(rows, 2).map((c) => c.tag)).toEqual(["a", "b"])
  })

  it("returns empty for an all-L1 directory", () => {
    expect(recentContacts([row("x", "ethereum-l1")])).toEqual([])
  })
})

describe("parseRequestAmount", () => {
  it("accepts positive amounts, with or without a $ prefix", () => {
    expect(parseRequestAmount("10")).toBe(10)
    expect(parseRequestAmount("$10.50")).toBe(10.5)
    expect(parseRequestAmount(" $3 ")).toBe(3)
  })

  it("rejects empty, zero, negative, and non-numeric input", () => {
    expect(parseRequestAmount("")).toBeNull()
    expect(parseRequestAmount("   ")).toBeNull()
    expect(parseRequestAmount("0")).toBeNull()
    expect(parseRequestAmount("-4")).toBeNull()
    expect(parseRequestAmount("ten")).toBeNull()
    expect(parseRequestAmount("$")).toBeNull()
  })
})

describe("request amount safety", () => {
  it.each(["1,000", "1,234", "1,23e3", "1.001", "0x10", "Infinity", "9007199254740993"])(
    "rejects %s instead of changing its value",
    (input) => {
      expect(parseRequestAmount(input)).toBeNull()
      expect(parseRequestAmount(decimalInput(input))).toBeNull()
    },
  )
})
