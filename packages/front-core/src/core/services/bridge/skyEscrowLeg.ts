import {
  encodeSkyEscrowDeploy,
  predictSkyEscrowAddressLocally,
  SkyRoute,
  type SkyEscrowArgs,
} from "@oxide/experiments/sky/sky_savings.js"
import { encodeSkyEscrowDeployOnly } from "@obsidion/sdk"
import type { Address } from "viem"
import type { EscrowKind, SkyLeg } from "./escrowLeg"

/** The Sky route an escrow of `direction` runs. */
export const skyRoute = (direction: "in" | "out"): SkyRoute =>
  direction === "in" ? SkyRoute.Stake : SkyRoute.Unstake

/** The leg of the Sky escrow at `escrow`, from its factory and what its address commits to. */
export function skyLeg(factory: Address, escrow: Address, args: SkyEscrowArgs): SkyLeg {
  const { nonce, recoveryCommitment, relayerTip } = args
  return { kind: "sky", factory, escrow, nonce, recoveryCommitment, relayerTip, args }
}

/** A Savings move's Sky escrow: the burn pays it as its recipient. */
export const skyEscrow: EscrowKind<SkyLeg> = {
  leg(record) {
    const sky = record.skyMove
    if (!sky) return undefined
    return skyLeg(sky.factory, record.recipient, {
      route: skyRoute(sky.direction),
      recipientCommitment: sky.recipientCommitment,
      recoveryCommitment: sky.recoveryCommitment,
      relayerTip: BigInt(sky.relayerTip),
      nonce: sky.nonce,
    })
  },
  predict: predictSkyEscrowAddressLocally,
  execute: encodeSkyEscrowDeploy,
  deploy: encodeSkyEscrowDeployOnly,
  // The run pays its tip to the escrow's own address: any nonzero address will do.
  payee: (leg) => leg.escrow,
}
