import { describe, expect, it } from "vitest"
import { resolveContactByCounterparty, resolveContactForTx, type ContactRow } from "../src/index.js"

// Characterization tests for the counterparty→contact resolution.

const L2_ADDR = "0x" + "ab".repeat(32)
const L1_ADDR = "0x1111111111111111111111111111111111111111"

const alice: ContactRow = {
  id: "alice",
  name: "Alice",
  tag: "alice",
  address: L2_ADDR,
  addressKind: "aztec-l2",
}

const coldWallet: ContactRow = {
  id: `l1:rainbow:${L1_ADDR}`,
  name: "My cold wallet",
  tag: "0x1111...1111",
  address: L1_ADDR,
  addressKind: "ethereum-l1",
  provider: "rainbow",
}

function directory(rows: ContactRow[]) {
  return {
    contacts: rows,
    lookup: (idOrTag: string) => rows.find((c) => c.id === idOrTag || c.tag === idOrTag),
    lookupByAddress: (address: string) => {
      const needle = address.toLowerCase()
      return rows.find((c) => c.addressKind !== "ethereum-l1" && c.address.toLowerCase() === needle)
    },
  }
}

describe("resolveContactByCounterparty", () => {
  it("resolves an address-shaped counterparty case-insensitively", () => {
    expect(resolveContactByCounterparty(L2_ADDR.toUpperCase(), directory([alice]))).toBe(alice)
  })

  it("scans L1 contacts by address too (deposit/withdrawal counterparties)", () => {
    expect(resolveContactByCounterparty(L1_ADDR, directory([coldWallet]))).toBe(coldWallet)
  })

  it("resolves a decorated @tag.zk.money and a bare tag to the same contact", () => {
    const dir = directory([alice])
    expect(resolveContactByCounterparty("@alice.zk.money", dir)).toBe(alice)
    expect(resolveContactByCounterparty("alice", dir)).toBe(alice)
  })

  it("falls back to the raw value when the bare-tag lookup misses", () => {
    const rawIdRow: ContactRow = { ...alice, id: "@weird", tag: "@weird" }
    const dir = {
      ...directory([rawIdRow]),
      lookup: (idOrTag: string) => (idOrTag === "@weird" ? rawIdRow : undefined),
    }
    expect(resolveContactByCounterparty("@weird", dir)).toBe(rawIdRow)
  })

  it("returns undefined for empty, whitespace, and unsaved counterparties", () => {
    const dir = directory([alice])
    expect(resolveContactByCounterparty("", dir)).toBeUndefined()
    expect(resolveContactByCounterparty("   ", dir)).toBeUndefined()
    expect(resolveContactByCounterparty("bob", dir)).toBeUndefined()
  })
})

describe("resolveContactForTx", () => {
  it("prefers the counterparty address over the display string", () => {
    const bob: ContactRow = {
      ...alice,
      id: "bob",
      tag: "bob",
      name: "Bob",
      address: "0x" + "cd".repeat(32),
    }
    expect(resolveContactForTx("bob", L2_ADDR, directory([alice, bob]))).toBe(alice)
  })

  it("falls back to bare-tag then raw lookup when the address is unset or unmatched", () => {
    const dir = directory([alice])
    expect(resolveContactForTx("@alice.zk.money", undefined, dir)).toBe(alice)
    expect(resolveContactForTx("alice", "0x" + "ee".repeat(32), dir)).toBe(alice)
  })

  it("returns undefined when nothing matches", () => {
    expect(resolveContactForTx("bob", "0x" + "ee".repeat(32), directory([alice]))).toBeUndefined()
  })
})
