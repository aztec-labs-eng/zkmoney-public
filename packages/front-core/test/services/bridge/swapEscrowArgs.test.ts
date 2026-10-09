import { describe, expect, it } from "vitest"
import type { Address, Hex } from "viem"
import { swapEscrowTarget } from "../../../src/core/services/bridge/swapEscrowArgs"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"

const base: WithdrawalRecord = {
  localId: "w1",
  recipient: `0x${"b0".repeat(20)}` as Address,
  recipientProvenance: "saved-recipient",
  amount: "100",
  tokenSymbol: "DAI",
  phase: "swapping",
  startTime: 0,
  swapOutput: "ETH",
  swapEscrow: `0x${"e5".repeat(20)}` as Address,
  swapEscrowFactory: `0x${"fa".repeat(20)}` as Address,
  swapNonce: `0x${"77".repeat(32)}` as Hex,
  swapRecoveryCommitment: `0x${"5a".repeat(32)}` as Hex,
  swapRelayerTip: "5000000000000000000",
}

describe("swapEscrowTarget", () => {
  it("reads a record without a layout as a legacy escrow, in the legacy struct order", () => {
    expect(swapEscrowTarget(base)).toEqual({
      factory: base.swapEscrowFactory,
      escrow: base.swapEscrow,
      layout: "legacy",
      args: {
        route: 2,
        recipient: base.recipient,
        recoveryCommitment: base.swapRecoveryCommitment,
        relayerTip: 5000000000000000000n,
        nonce: base.swapNonce,
      },
    })
  })

  it("rebuilds a v2 escrow with its gas swap, 0 where the record has none", () => {
    const v2 = { ...base, swapOutput: "USDC" as const, swapEscrowLayout: "v2" as const }
    expect(swapEscrowTarget(v2)).toMatchObject({
      layout: "v2",
      args: { route: 0, daiForGas: 0n, minEthForGas: 0n },
    })
    expect(
      swapEscrowTarget({ ...v2, swapDaiForGas: "5000000000000000000", swapMinEthForGas: "7" }),
    ).toMatchObject({ layout: "v2", args: { daiForGas: 5n * 10n ** 18n, minEthForGas: 7n } })
  })

  it("is undefined for a direct withdrawal and for any missing committed value", () => {
    expect(swapEscrowTarget({ ...base, swapOutput: undefined })).toBeUndefined()
    for (const field of [
      "swapEscrow",
      "swapEscrowFactory",
      "swapNonce",
      "swapRecoveryCommitment",
      "swapRelayerTip",
    ] as const) {
      expect(swapEscrowTarget({ ...base, [field]: undefined }), field).toBeUndefined()
    }
  })
})
