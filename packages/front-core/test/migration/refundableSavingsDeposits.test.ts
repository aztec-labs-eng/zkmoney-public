// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { computeRecipientCommitment } from "@oxide/oxide-lib/recipient_commitment.js"
import { deriveSkyEscrowSalts } from "../../src/oxide/oxideAccountKeys"
import { refundableSavingsDeposits } from "../../src/oxide/refundableSavingsDeposits"

const h = vi.hoisted(() => ({ portals: vi.fn(), logs: vi.fn() }))
vi.mock("../../src/core/services/savings/savingsDeployment", () => ({
  readSkyFactoryPortals: h.portals,
}))
vi.mock("@obsidion/sdk", () => ({ chunkedContractEvents: h.logs }))
const dai = `0x${"11".repeat(20)}` as const
const sky = `0x${"22".repeat(20)}` as const
const factory = `0x${"33".repeat(20)}`
const nonce = `0x${"44".repeat(32)}` as const
const owner = AztecAddress.fromStringUnsafe(`0x${"00".repeat(31)}01`)
const masterSecret = new Fr(5n)
const salt = deriveSkyEscrowSalts(masterSecret, nonce).recipient
const commitment = (await computeRecipientCommitment(salt, owner)).toString()
const move = { direction: "in" as const, factory, nonce, recipientCommitment: commitment }
const event = {
  args: { key: "0x1234", index: 922624n, amount: 40n * 10n ** 18n },
  blockNumber: 1928n,
  removed: false,
}
const input = () => ({
  publicClient: {} as never,
  portal: sky,
  recipient: owner.toString(),
  masterSecret,
  moves: [move],
  fromBlock: 112n,
  head: 2000n,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.portals.mockResolvedValue({ daiPortal: dai, sUsdsPortal: sky })
  h.logs.mockResolvedValue([event])
})
describe("refundable Savings deposits", () => {
  it("recovers an unclaimed Savings deposit from its withdrawal memo without browser records", async () => {
    expect(await refundableSavingsDeposits(input())).toEqual([
      {
        messageKey: "0x1234",
        messageLeafIndex: "922624",
        l1BlockNumber: "1928",
        amount: "40000000000000000000",
        sharedSecretSalt: salt.toString(),
      },
    ])
    expect(h.logs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        address: sky,
        args: { recipientCommitment: commitment },
      }),
      112n,
      2000n,
    )
  })
  it("finds a move out on DAI's portal", async () => {
    expect(
      await refundableSavingsDeposits({
        ...input(),
        portal: dai,
        moves: [{ ...move, direction: "out" }],
      }),
    ).toHaveLength(1)
  })
  it("does not send a Savings deposit through another portal", async () => {
    expect(await refundableSavingsDeposits({ ...input(), portal: dai })).toEqual([])
    expect(h.logs).not.toHaveBeenCalled()
  })
  it("skips and reports a move whose commitment this account does not reproduce", async () => {
    const onUnverified = vi.fn()
    expect(
      await refundableSavingsDeposits({ ...input(), masterSecret: new Fr(6n), onUnverified }),
    ).toEqual([])
    expect(onUnverified).toHaveBeenCalledWith(move)
    expect(h.logs).not.toHaveBeenCalled()
  })
  it("does not count a duplicate memo or a removed log twice", async () => {
    h.logs.mockResolvedValue([event, { ...event, removed: true }])
    expect(await refundableSavingsDeposits({ ...input(), moves: [move, move] })).toHaveLength(1)
    expect(h.portals).toHaveBeenCalledTimes(1)
  })
  it("propagates a failed deposit scan instead of reporting no funds", async () => {
    h.logs.mockRejectedValue(new Error("RPC unavailable"))
    await expect(refundableSavingsDeposits(input())).rejects.toThrow("RPC unavailable")
  })
  it("rejects incomplete deposit inputs", async () => {
    h.logs.mockResolvedValue([{ ...event, args: { ...event.args, key: undefined } }])
    await expect(refundableSavingsDeposits(input())).rejects.toThrow("incomplete refund inputs")
  })
})
