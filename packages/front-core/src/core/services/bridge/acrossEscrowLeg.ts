import {
  acrossBridgeEscrowArgs,
  encodeAcrossBridgeEscrowDeploy,
  encodeAcrossBridgeEscrowDeployOnly,
  predictAcrossBridgeEscrowAddressLocally,
  type BridgeOutToken,
} from "@obsidion/sdk"
import type { BridgeLeg, EscrowKind } from "./escrowLeg"

/**
 * An Across bridge-out's escrow. The route's tokens and decimals follow from the output token and
 * the chain, so the record keeps only what the wallet chose.
 */
export const acrossEscrow: EscrowKind<BridgeLeg> = {
  leg(record) {
    const { bridgeOut, swapOutput, swapEscrow: escrow, swapEscrowFactory: factory } = record
    if (!bridgeOut || !escrow || !factory) return undefined
    if (swapOutput !== "USDC" && swapOutput !== "USDT") return undefined
    const token: BridgeOutToken = swapOutput
    const values = {
      recipient: record.recipient,
      acrossFee: BigInt(bridgeOut.acrossFee),
      recoveryCommitment: bridgeOut.recoveryCommitment,
      relayerTip: BigInt(bridgeOut.relayerTip),
      nonce: bridgeOut.nonce,
    }
    const args = acrossBridgeEscrowArgs(token, bridgeOut.chainId, values)
    if (!args) return undefined
    return {
      kind: "bridge",
      provider: "across",
      factory,
      escrow,
      nonce: values.nonce,
      recoveryCommitment: values.recoveryCommitment,
      relayerTip: values.relayerTip,
      args,
      destination: {
        chainId: bridgeOut.chainId,
        token,
        recipient: record.recipient,
        minReceived: BigInt(bridgeOut.minReceived),
      },
    }
  },
  predict: predictAcrossBridgeEscrowAddressLocally,
  execute: encodeAcrossBridgeEscrowDeploy,
  deploy: encodeAcrossBridgeEscrowDeployOnly,
  payee: (leg) => leg.destination.recipient,
}
