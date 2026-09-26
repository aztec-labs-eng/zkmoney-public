import type { Address } from "viem"
import { swapRouteForOutput, type SwapEscrowArgs } from "@obsidion/sdk"
import type { WithdrawalRecord } from "./types"

type SwapEscrowFields = Pick<
  WithdrawalRecord,
  | "recipient"
  | "swapOutput"
  | "swapEscrow"
  | "swapEscrowFactory"
  | "swapNonce"
  | "swapRecoveryCommitment"
  | "swapRelayerTip"
>

/** Everything a self-run swap or a recovery targets: the factory, the escrow, and the args its address commits to. */
export interface SwapEscrowTarget {
  factory: Address
  escrow: Address
  args: SwapEscrowArgs
}

/**
 * Rebuild the escrow args a swap record's burn committed to. Undefined for a direct withdrawal and
 * for a swap record missing any committed value.
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
  return {
    factory: record.swapEscrowFactory,
    escrow: record.swapEscrow,
    args: {
      route: swapRouteForOutput(record.swapOutput),
      recipient: record.recipient,
      recoveryCommitment: record.swapRecoveryCommitment,
      relayerTip: BigInt(record.swapRelayerTip),
      nonce: record.swapNonce,
    },
  }
}
