import {
  encodeSkyEscrowDeploy,
  predictSkyEscrowAddressLocally,
} from "@oxide/experiments/sky/sky_savings.js"
import { encodeSkyEscrowDeployOnly } from "@obsidion/sdk"
import { savingsRoute } from "../savings/savingsMoveQuote"
import type { EscrowKind, SkyLeg } from "./escrowLeg"

/** A Savings move's Sky escrow: the burn pays it as its recipient. */
export const skyEscrow: EscrowKind<SkyLeg> = {
  leg(record) {
    const sky = record.skyMove
    if (!sky) return undefined
    const relayerTip = BigInt(sky.relayerTip)
    return {
      kind: "sky",
      factory: sky.factory,
      escrow: record.recipient,
      nonce: sky.nonce,
      recoveryCommitment: sky.recoveryCommitment,
      relayerTip,
      args: {
        route: savingsRoute(sky.direction),
        recipientCommitment: sky.recipientCommitment,
        recoveryCommitment: sky.recoveryCommitment,
        relayerTip,
        nonce: sky.nonce,
      },
    }
  },
  predict: predictSkyEscrowAddressLocally,
  execute: encodeSkyEscrowDeploy,
  deploy: encodeSkyEscrowDeployOnly,
  // The run pays its tip to the escrow's own address: any nonzero address will do.
  payee: (leg) => leg.escrow,
}
