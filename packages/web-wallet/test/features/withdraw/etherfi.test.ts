// @vitest-environment node
/**
 * The saved ether.fi Cash address: the most recently used live row is the default, a replacement
 * rewrites that row, and a rewrite the store refuses saves afresh.
 */
import { describe, expect, it } from "vitest"
import { getAddress } from "viem"
import type { Contact, RecordSet } from "@obsidion/front-core"
import {
  etherfiRoutes,
  saveEtherfiAddress,
  savedEtherfiAddress,
} from "../../../src/features/withdraw/etherfi"
import type { BridgeOutChain } from "../../../src/features/withdraw/bridgeOutQuote"
import { testContacts } from "../../support/contacts"

const SAVED = getAddress(`0x${"aa".repeat(20)}`)
const NEXT = getAddress(`0x${"bb".repeat(20)}`)

const etherfiRow = (address: string, lastUsedAt: number, deletedAt?: number): Contact =>
  ({
    name: "ether.fi Cash",
    address,
    addressKind: "ethereum-l1",
    l1Wallet: { provider: "etherfi", provenance: "saved-recipient", lastUsedAt, deletedAt },
  } as Contact)

const loaded = (records: Contact[]): RecordSet<Contact> => ({
  records,
  loaded: true,
  failed: false,
})

async function bookOf(rows: Contact[]) {
  const book = testContacts()
  await book.addEntries(rows)
  await book.all()
  return book
}

describe("etherfiRoutes", () => {
  const route = (chainId: number, name: string): BridgeOutChain => ({
    provider: "across",
    l2Token: `0x${"0b".repeat(32)}`,
    chain: { chainId, name, etaMinutes: 3, rpcUrl: `https://${name}.example`, in: [] },
    tokens: [{ symbol: "USDC", address: getAddress(`0x${"22".repeat(20)}`) }],
  })

  it("keeps the routes on the chains that take the account's own address", () => {
    const base = route(8453, "base")
    const optimism = route(10, "optimism")
    const arbitrum = route(42161, "arbitrum")
    expect(etherfiRoutes([route(137, "polygon"), base, optimism, arbitrum])).toEqual([
      base,
      optimism,
      arbitrum,
    ])
  })
})

describe("savedEtherfiAddress", () => {
  it.each([
    ["the most recently used row", [etherfiRow(SAVED, 1), etherfiRow(NEXT, 2)], NEXT],
    ["no removed row", [etherfiRow(SAVED, 1, 2)], null],
    ["a removed row used again since", [etherfiRow(SAVED, 3, 2)], SAVED],
  ])("picks %s", (_, rows, expected) => {
    expect(savedEtherfiAddress(loaded(rows))).toBe(expected)
  })
})

describe("saveEtherfiAddress", () => {
  it("rewrites the saved row when a new address replaces it", async () => {
    const book = await bookOf([etherfiRow(SAVED, 1)])
    await saveEtherfiAddress(book, NEXT, SAVED)
    const rows = await book.all()
    expect(rows.map((r) => r.address)).toEqual([NEXT])
    expect(savedEtherfiAddress(book.view.get())).toBe(NEXT)
  })

  it("saves afresh when the store refuses the rewrite", async () => {
    const book = await bookOf([etherfiRow(SAVED, 2), etherfiRow(NEXT, 1)])
    // The rewrite collides with the live NEXT row.
    await expect(
      book.updateL1WalletContact({
        originalAddress: SAVED,
        provider: "etherfi",
        address: NEXT,
        name: "ether.fi Cash",
      }),
    ).rejects.toThrow()
    await saveEtherfiAddress(book, NEXT, SAVED)
    expect(savedEtherfiAddress(book.view.get())).toBe(NEXT)
  })
})
