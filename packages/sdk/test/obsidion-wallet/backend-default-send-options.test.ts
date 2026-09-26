/**
 * Unit test for `ObsidionWalletBackend.getDefaultSendOptions`.
 *
 * The backend deploy wallet pays through its own SponsorFPC once
 * setOwnSponsorFPCAddress is called. With no SponsorFPC it fails loud
 * (testnet/sandbox always deploy one) unless setAllowDirectFeeJuice(true) was
 * called — the mainnet minimal deploy, which skips the drainable SponsorFPC and
 * has the sender pay from its own bridged fee juice.
 *
 * Mock PXE / node in the style of `get-default-send-options.test.ts`.
 */
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { GasSettings } from "@aztec/stdlib/gas"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ObsidionWalletBackend } from "../../src/obsidion/ObsidionWalletBackend.js"
import { ObsidionFeeJuicePaymentMethod } from "../../src/feePaymentMethod/obsidion_feepayment_method.js"

const stubPxe = {} as any
const stubNode = {} as any

function makeBackend(): ObsidionWalletBackend {
  return new ObsidionWalletBackend(stubPxe, stubNode)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ObsidionWalletBackend.getDefaultSendOptions", () => {
  const from = AztecAddress.fromBigIntUnsafe(0x42n)
  const SPONSOR_FPC = AztecAddress.fromBigIntUnsafe(0x20n)

  it("throws when no SponsorFPC is set and direct fee juice is not allowed (testnet/sandbox fail-loud)", async () => {
    const wallet = makeBackend()
    await expect(wallet.getDefaultSendOptions(from)).rejects.toThrow(/Sponsor FPC address not set/)
  })

  it("returns { from } with no fee payer when direct fee juice is allowed (mainnet minimal deploy)", async () => {
    // `{ from }` with no fee payer makes the base wallet's completeFeeOptions
    // select PREEXISTING_FEE_JUICE, so the sender (admin) pays from its own
    // bridged balance.
    const wallet = makeBackend()
    wallet.setAllowDirectFeeJuice(true)
    const opts = await wallet.getDefaultSendOptions(from)
    expect(opts.from).toBe(from)
    expect(opts.fee).toBeUndefined()
  })

  it("routes through our SponsorFPC once setOwnSponsorFPCAddress is called", async () => {
    const wallet = makeBackend()
    // getGasSettings hits the node; stub it so the unit stays node-free.
    ;(wallet as any).getGasSettings = async () => GasSettings.empty()
    wallet.setOwnSponsorFPCAddress(SPONSOR_FPC)

    const opts = await wallet.getDefaultSendOptions(from)
    expect(opts.from).toBe(from)
    expect(opts.fee?.paymentMethod).toBeInstanceOf(ObsidionFeeJuicePaymentMethod)
  })
})
