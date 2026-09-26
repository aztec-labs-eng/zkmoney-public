/**
 * Stamping the funding transfer RACES the deposit record's own creation, and normally loses: the L1
 * receipt lands seconds after the transfer, while only the sync loop's event discovery may create
 * the record, on its next tick. So the ordering these cover is the common one — hash first, record
 * second — and the hash has to survive the gap.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import { formatUnits, parseUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { TX_AMOUNT_CAP } from "@obsidion/sdk"
import {
  depositWindowError,
  drainFundingTxStash,
  getSipaDepositGateway,
  stampFundingTx,
  type FundingStamp,
} from "../src/features/deposit/sipaGateway"
import { seedBootConfig } from "./seedBootConfig"

vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ token: `0x${"ee".repeat(20)}` }),
}))

const SIPA = `0x${"ab".repeat(20)}` as Address
/** The same address as a wallet or an explorer hands it back. */
const MIXED_CASE_SIPA = `0x${"Ab".repeat(20)}` as Address
const OTHER = `0x${"cd".repeat(20)}` as Address
const HASH = `0x${"11".repeat(32)}` as Hex
const OTHER_HASH = `0x${"22".repeat(32)}` as Hex

function makeStore() {
  const records = new Map<string, Record<string, unknown>>()
  /** The addresses upsert was called with, before the store lowercases them into keys. */
  const upsertKeys: Address[] = []
  return {
    records,
    upsertKeys,
    load: async () => {},
    get: (address: Address) => records.get(address.toLowerCase()) ?? null,
    upsert: async (address: Address, patch: Record<string, unknown>) => {
      upsertKeys.push(address)
      const key = address.toLowerCase()
      const next = { ...(records.get(key) ?? {}), ...patch }
      records.set(key, next)
      return next
    },
    /** What event discovery does on a sync pass. */
    discover: (address: Address, phase: string) => {
      records.set(address.toLowerCase(), { sipaAddress: address, phase })
    },
  }
}

describe("stampFundingTx", () => {
  let pending: Map<string, FundingStamp>

  beforeEach(() => {
    pending = new Map()
  })

  it("stamps a record that already exists without touching its phase", async () => {
    const store = makeStore()
    store.discover(SIPA, "sweeping")

    await stampFundingTx(store as never, pending, SIPA, { fundingTxHash: HASH })

    expect(store.records.get(SIPA)).toMatchObject({ phase: "sweeping", fundingTxHash: HASH })
    expect(pending.size).toBe(0)
  })

  it("never blanks a stored field with an undefined stamp value", async () => {
    const store = makeStore()
    store.records.set(SIPA, { sipaAddress: SIPA, phase: "sweeping", tokenSymbol: "DAI" })

    await stampFundingTx(store as never, pending, SIPA, {
      fundingTxHash: HASH,
      tokenSymbol: undefined,
    })

    expect(store.records.get(SIPA)).toMatchObject({ tokenSymbol: "DAI", fundingTxHash: HASH })
  })

  it("carries the record's reorg epoch, so the store's fence cannot silently drop the stamp", async () => {
    const store = makeStore()
    store.records.set(SIPA, { sipaAddress: SIPA, phase: "pendingClaim", reorgEpoch: 2 })

    await stampFundingTx(store as never, pending, SIPA, { fundingTxHash: HASH })

    expect(store.records.get(SIPA)).toMatchObject({ reorgEpoch: 2, fundingTxHash: HASH })
  })

  it("writes under the address the record itself stores, not the caller's casing", async () => {
    const store = makeStore()
    store.discover(SIPA, "sweeping")

    await stampFundingTx(store as never, pending, MIXED_CASE_SIPA, { fundingTxHash: HASH })

    expect(store.upsertKeys).toEqual([SIPA])
  })

  it("stashes a hash that beats event discovery rather than losing it", async () => {
    const store = makeStore()

    await stampFundingTx(store as never, pending, SIPA, { fundingTxHash: HASH })

    // Nothing may be created here: the note fields recovery needs are not in hand.
    expect(store.records.size).toBe(0)
    expect(pending.get(SIPA)).toEqual({ fundingTxHash: HASH })
  })

  it("lands the stashed hash on the sync pass that creates the record", async () => {
    const store = makeStore()
    await stampFundingTx(store as never, pending, SIPA, { fundingTxHash: HASH })

    store.discover(SIPA, "broadcast")
    await drainFundingTxStash(store as never, pending)

    expect(store.records.get(SIPA)).toMatchObject({ phase: "broadcast", fundingTxHash: HASH })
    expect(pending.size).toBe(0)
  })

  it("holds a hash whose record is still undiscovered for a later pass", async () => {
    const store = makeStore()
    await stampFundingTx(store as never, pending, SIPA, { fundingTxHash: HASH })
    await stampFundingTx(store as never, pending, OTHER, { fundingTxHash: OTHER_HASH })

    store.discover(OTHER, "broadcast")
    await drainFundingTxStash(store as never, pending)

    expect(store.records.get(OTHER)).toMatchObject({ fundingTxHash: OTHER_HASH })
    expect([...pending]).toEqual([[SIPA, { fundingTxHash: HASH }]])
  })
})

/**
 * The gate every funding path runs through, including the desktop bridge. The bridge has no form of
 * its own, so this gate is all that stands between a browser-approved transfer and a stranded
 * deposit.
 */
describe("depositWindowError", () => {
  const CAP = formatUnits(TX_AMOUNT_CAP, DEFAULT_DECIMALS)
  const dai = (display: string) => parseUnits(display, 18)
  const FEE = dai("0.35")

  it("refuses a send at or below the quoted fee", () => {
    expect(depositWindowError(FEE, FEE, 18, "DAI")).toContain(
      "must exceed the deposit fee (0.35 DAI)",
    )
    expect(depositWindowError(dai("0.34"), FEE, 18, "DAI")).toBeDefined()
  })

  it("refuses a send whose credited amount would exceed the cap, naming the maximum", () => {
    // The fee rides on top of what the portal meters, so the cap plus the fee is still accepted.
    expect(depositWindowError(dai(CAP) + FEE, FEE, 18, "DAI")).toBeUndefined()
    expect(depositWindowError(dai(CAP) + FEE + 1n, FEE, 18, "DAI")).toBe(
      `Deposit up to ${CAP} DAI at a time`,
    )
  })

  it("measures a 6-decimal token in its own units", () => {
    const usdc = (display: string) => parseUnits(display, 6)
    const fee = usdc("0.35")
    expect(depositWindowError(usdc("100"), fee, 6, "USDC")).toBeUndefined()
    expect(depositWindowError(usdc(CAP) + fee + 1n, fee, 6, "USDC")).toBe(
      `Deposit up to ${CAP} USDC at a time`,
    )
  })
})

/** The refusal names what the user actually sent, not the token the pool settles in. */
describe("the deposit window gate, over a send in another token", () => {
  beforeAll(seedBootConfig)

  it("names the sent token in the refusal", async () => {
    const gateway = getSipaDepositGateway() as unknown as {
      tokenMeta: () => Promise<{ address: Address; symbol: string; decimals: number }>
      quotedFee: () => Promise<bigint>
      deposit: (params: Record<string, unknown>) => Promise<unknown>
    }
    gateway.tokenMeta = async () => ({ address: OTHER, symbol: "DAI", decimals: 18 })
    gateway.quotedFee = async () => parseUnits("0.35", 18)

    await expect(
      gateway.deposit({
        target: { address: SIPA, name: "alice.oxide.eth" },
        amountDisplay: "0.1",
        tokenSymbol: "USDC",
        token: { address: OTHER, decimals: 6 },
      }),
    ).rejects.toThrow("Amount must exceed the deposit fee (0.35 USDC)")
  })
})
