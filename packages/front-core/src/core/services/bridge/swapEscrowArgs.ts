import type { Address } from "viem"
import { swapRouteForOutput, type SwapEscrowCommitment } from "@obsidion/sdk"
import type { WithdrawalRecord } from "./types"

type SwapEscrowFields = Pick<
  WithdrawalRecord,
  | "recipient"
  | "swapOutput"
  | "swapEscrow"
  | "swapEscrowFactory"
  | "swapEscrowLayout"
  | "swapNonce"
  | "swapRecoveryCommitment"
  | "swapRelayerTip"
  | "swapDaiForGas"
  | "swapMinEthForGas"
>

/** Everything a self-run swap or a recovery targets: the factory, the escrow, and the args its address commits to. */
export type SwapEscrowTarget = { factory: Address; escrow: Address } & SwapEscrowCommitment

/**
 * Rebuild the escrow args a swap record's burn committed to, in its factory's layout. Undefined for
 * a direct withdrawal and for a swap record missing any committed value.
 */
export function swapEscrowTarget(record: SwapEscrowFields): SwapEscrowTarget | undefined {
  if (
    !record.swapOutput ||
    !record.swapEscrow ||
    !record.swapEscrowFactory ||
    !record.swapNonce ||
    !record.swapRecoveryCommitment ||
    record.swapRelayerTip === undefined
  ) {
    return undefined
  }
  const args = {
    route: swapRouteForOutput(record.swapOutput),
    recipient: record.recipient,
    recoveryCommitment: record.swapRecoveryCommitment,
    relayerTip: BigInt(record.swapRelayerTip),
    nonce: record.swapNonce,
  }
  const escrow = { factory: record.swapEscrowFactory, escrow: record.swapEscrow }
  if (record.swapEscrowLayout !== "v2") return { ...escrow, layout: "legacy", args }
  return {
    ...escrow,
    layout: "v2",
    args: {
      ...args,
      daiForGas: BigInt(record.swapDaiForGas ?? 0),
      minEthForGas: BigInt(record.swapMinEthForGas ?? 0),
    },
  }
}
