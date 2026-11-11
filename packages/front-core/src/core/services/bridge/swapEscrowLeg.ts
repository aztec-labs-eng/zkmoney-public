import {
  encodeSwapEscrowDeployOnly,
  encodeSwapEscrowExecute,
  predictSwapEscrow,
  swapRouteForOutput,
} from "@obsidion/sdk"
import type { EscrowKind, SwapLeg } from "./escrowLeg"

/** A swap-on-withdraw's escrow, in its factory's `Args` layout. */
export const swapEscrow: EscrowKind<SwapLeg> = {
  leg(record) {
    const { swapOutput, swapEscrow: escrow, swapEscrowFactory: factory } = record
    const { swapNonce: nonce, swapRecoveryCommitment: recoveryCommitment } = record
    if (!swapOutput || !escrow || !factory || !nonce || !recoveryCommitment) return undefined
    if (record.swapRelayerTip === undefined) return undefined
    const relayerTip = BigInt(record.swapRelayerTip)
    const values = { factory, escrow, nonce, recoveryCommitment, relayerTip }
    const args = {
      route: swapRouteForOutput(swapOutput),
      recipient: record.recipient,
      recoveryCommitment,
      relayerTip,
      nonce,
    }
    if (record.swapEscrowLayout !== "v2") {
      return { kind: "swap", ...values, args: { layout: "legacy", args } }
    }
    const daiForGas = BigInt(record.swapDaiForGas ?? 0)
    const minEthForGas = BigInt(record.swapMinEthForGas ?? 0)
    return {
      kind: "swap",
      ...values,
      args: { layout: "v2", args: { ...args, daiForGas, minEthForGas } },
    }
  },
  predict: predictSwapEscrow,
  execute: encodeSwapEscrowExecute,
  deploy: encodeSwapEscrowDeployOnly,
  payee: (leg) => leg.args.args.recipient,
}
