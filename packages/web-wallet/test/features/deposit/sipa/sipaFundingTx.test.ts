/**
 * Stamping the funding transfer RACES the deposit record's own creation, and normally loses: the L1
 * receipt lands seconds after the transfer, while only the scan's discovery may create the
 * record. So the ordering these cover is the common one — hash first, record second — and the hash
 * has to survive the gap.
 */
import { describe, expect, it } from "vitest"
import type { Address, Hex } from "viem"
import { formatUnits, parseUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  createFundingStamps,
  depositWindowError,
} from "../../../../src/features/deposit/fundDeposit"
import {
  createSipaDeposits,
  memoryBackend,
  openDatabase,
  type SipaDeposit,
} from "@obsidion/front-core"

const TX_AMOUNT_CAP = 5166n * 10n ** 18n
const SIPA = `0x${"ab".repeat(20)}` as Address
/** The same address as a wallet or an explorer hands it back. */
const OTHER = `0x${"cd".repeat(20)}` as Address
const HASH = `0x${"11".repeat(32)}` as Hex
const OTHER_HASH = `0x${"22".repeat(32)}` as Hex

/** A deposit store over memory; `discover` is what event discovery does on a sync pass. */
function makeStore() {
  const store = createSipaDeposits({ db: openDatabase(memoryBackend()), account: true })
  const discover = (address: Address, fields: Partial<SipaDeposit> = {}) =>
    store.adopt({
      sipaAddress: address,
      phase: "broadcast",
      recipientL2Address: "0xrecipient",
      messageSecret: "0xsecret",
      recipientHash: "0xhash",
      recoveryAddress: "",
      l1ChainId: 1,
      networkId: "0xnet",
      amount: "0",
      tokenSymbol: "DAI",
      startTime: 1,
      ...fields,
    })
  return Object.assign(store, { discover })
}

describe("createFundingStamps", () => {
  it("never blanks a stored field with an undefined stamp value", async () => {
    const store = makeStore()
    await store.discover(SIPA, { phase: "sweeping", tokenSymbol: "DAI" })

    await createFundingStamps(store).stamp(SIPA, { fundingTxHash: HASH, tokenSymbol: undefined })

    expect(await store.get(SIPA)).toMatchObject({ tokenSymbol: "DAI", fundingTxHash: HASH })
  })

  it("holds a hash whose record is still undiscovered for a later pass", async () => {
    const store = makeStore()
    const stamps = createFundingStamps(store)
    await stamps.stamp(SIPA, { fundingTxHash: HASH })
    await stamps.stamp(OTHER, { fundingTxHash: OTHER_HASH })

    await store.discover(OTHER)
    await stamps.drain()
    expect(await store.get(OTHER)).toMatchObject({ fundingTxHash: OTHER_HASH })
    expect((await store.get(SIPA))?.fundingTxHash).toBeUndefined()

    await store.discover(SIPA)
    await stamps.drain()
    expect(await store.get(SIPA)).toMatchObject({ fundingTxHash: HASH })
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
  const FEE = dai("0.25")

  it("refuses a send at or below the quoted fee, naming the fee in the sent token", () => {
    const refusal = depositWindowError(FEE, FEE, 18, "USDC", TX_AMOUNT_CAP, 18)
    expect(refusal).toMatchObject({
      code: "deposit.belowFee",
      data: { fee: "0.25", symbol: "USDC" },
    })
    expect(depositWindowError(dai("0.24"), FEE, 18, "DAI", TX_AMOUNT_CAP, 18)?.code).toBe(
      "deposit.belowFee",
    )
  })

  it("measures a send to a 6-decimal row against that row's own cap", () => {
    const usdc = (display: string) => parseUnits(display, 6)
    const fee = usdc("0.25")
    const cap = usdc("1000")
    expect(depositWindowError(usdc("1000") + fee, fee, 6, "USDC", cap, 6)).toBeUndefined()
    expect(depositWindowError(usdc("1000") + fee + 1n, fee, 6, "USDC", cap, 6)?.code).toBe(
      "deposit.overCap",
    )
  })

  it("measures a 6-decimal token swapped into an 18-decimal row in its own units", () => {
    const usdc = (display: string) => parseUnits(display, 6)
    const fee = usdc("0.25")
    expect(depositWindowError(usdc("100"), fee, 6, "USDC", TX_AMOUNT_CAP, 18)).toBeUndefined()
    expect(depositWindowError(usdc(CAP) + fee, fee, 6, "USDC", TX_AMOUNT_CAP, 18)).toBeUndefined()
    expect(depositWindowError(usdc(CAP) + fee + 1n, fee, 6, "USDC", TX_AMOUNT_CAP, 18)?.code).toBe(
      "deposit.overCap",
    )
  })
})
