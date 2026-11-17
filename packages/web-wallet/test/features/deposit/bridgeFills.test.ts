import { describe, expect, it, vi } from "vitest"
import { formatTransactionReceipt, type Address, type Hex } from "viem"
import receiptFixture from "../../../../front-core/test/fixtures/across/fillReceipt.json"
import { fillReader } from "../../../src/features/deposit/bridgeChains"
import { bridgeFillDetectors } from "../../../src/session/bridgeFillDetectors"

// A mainnet SpokePool transaction that filled two deposits; the second paid USDT to its depositor.
const receipt = formatTransactionReceipt(receiptFixture as never)
const HASH = receipt.transactionHash as Hex
const PAID = "0xb28247e84ce3fbeb6e74cb006978a52bb73e0ac6" as Address
const SPOKE_POOL = "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5"
const profile = (spokePool?: string) =>
  ({
    features: {
      across: { apiUrl: "https://across.example/api", chains: [], oxide: {}, spokePool },
    },
  } as never)

describe("fillReader", () => {
  const client = { getTransactionReceipt: vi.fn(async () => receipt) }
  const reader = fillReader(client as never, bridgeFillDetectors(profile(SPOKE_POOL)))

  it("reads the fill that paid the address from its funding receipt", async () => {
    expect(await reader.fill(HASH, PAID)).toMatchObject({
      originChainId: 56,
      depositId: "1271856",
      inputAmount: 9_931_000_000_000_000_000n,
      value: 9_897_817n,
    })
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: HASH })
  })

  it("finds none for an address no fill paid", async () => {
    expect(await reader.fill(HASH, `0x${"e9".repeat(20)}`)).toBeUndefined()
  })

  it("finds none where the profile names no SpokePool for its fills", async () => {
    const unnamed = fillReader(client as never, bridgeFillDetectors(profile()))
    expect(await unnamed.fill(HASH, PAID)).toBeUndefined()
  })

  it("fails when the receipt read fails", async () => {
    const down = fillReader(
      { getTransactionReceipt: async () => Promise.reject(new Error("rpc down")) } as never,
      bridgeFillDetectors(profile(SPOKE_POOL)),
    )
    await expect(down.fill(HASH, PAID)).rejects.toThrow()
  })
})
