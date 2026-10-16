import { decodeRequestInline, type PaymentRequest } from "@obsidion/front-core"
import { describe, expect, it, vi } from "vitest"
import { createAndStoreRequestLink } from "../src/features/requests/requestLinkCreation"

const FIELD_ID = `0x${"0a".repeat(32)}`
const TOKEN_ADDRESS = `0x${"1b".repeat(32)}`

const input = {
  requestId: FIELD_ID,
  requesterTag: "alice",
  requesterAddress: `0x${"2c".repeat(32)}`,
  tokenAddress: TOKEN_ADDRESS,
  tokenDecimals: 18,
  tokenSymbol: "DAI",
  networkId: "0xrollup",
  baseUrl: "https://paylink.test.zk.money",
  amountInput: "25",
  noteInput: "dinner",
  durationMs: 30 * 86_400_000,
  now: 1_800_000_000_000,
}

describe("createAndStoreRequestLink", () => {
  it("persists the outgoing join row before returning the link", async () => {
    const writes: PaymentRequest[] = []
    const result = await createAndStoreRequestLink(input, {
      add: async (row) => {
        writes.push(row)
      },
    })

    expect(writes).toEqual([result.row])
    expect(decodeRequestInline(result.url.split("#")[1])).toMatchObject({
      requestId: FIELD_ID,
      requesterTag: "alice",
      tokenAddress: TOKEN_ADDRESS,
      amountAtomic: 25_000_000_000_000_000_000n,
      note: "dinner",
    })
  })

  it("carries the recorded preimage of the link's address", async () => {
    const sipaAddress = `0x${"3d".repeat(20)}`
    const preimage = { intentHash: `0x${"4e".repeat(32)}`, recovery: `0x${"5f".repeat(32)}` }
    const preimageOf = vi.fn(async () => preimage)
    const result = await createAndStoreRequestLink(
      { ...input, sipaAddress },
      { add: async () => {} },
      preimageOf,
    )
    expect(preimageOf).toHaveBeenCalledWith(sipaAddress)
    expect(decodeRequestInline(result.url.split("#")[1]).sipaPreimage).toEqual(preimage)
    expect(result.row.sipaPreimage).toEqual(preimage)
  })

  it("does not reveal a result when persistence fails", async () => {
    const error = new Error("quota exceeded")
    const add = vi.fn().mockRejectedValue(error)

    await expect(createAndStoreRequestLink(input, { add })).rejects.toBe(error)
    expect(add).toHaveBeenCalledOnce()
  })
})
