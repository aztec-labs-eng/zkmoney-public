/** `ObsidionWallet.getDefaultSendOptions` fails closed with a typed error. */
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { describe, expect, it } from "vitest"

import { ObsidionWallet } from "../../src/obsidion/ObsidionWallet.js"
import { FeeUnavailableError } from "../../src/obsidion/FeeUnavailableError.js"

describe("ObsidionWallet.getDefaultSendOptions", () => {
  it("throws FeeUnavailableError", async () => {
    const wallet = new ObsidionWallet({} as any, {} as any)
    await expect(
      wallet.getDefaultSendOptions(AztecAddress.fromBigIntUnsafe(0x42n)),
    ).rejects.toBeInstanceOf(FeeUnavailableError)
  })
})
