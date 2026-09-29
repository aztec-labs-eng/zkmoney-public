import { CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';

import { ProverClaim } from '@oxide/l1-contracts/oxide_portal.js';

import { ObservedTx, PortalContext, TxRef } from '../types.js';

export type { ObservedTx, PortalContext, TxRef } from '../types.js';

/** Portal context for the prover-claim path: the prover subsidy the Portal calls to settle the subsidy at claim
 *  time. */
export type ProverClaimPortalContext = PortalContext & { proverSubsidy: EthAddress };

export interface ProverClaimResult {
  content: Fr;
  proverTip: bigint;
  // There may be more than one withdrawal for a portal in a transaction.
  // This is the index of the withdrawal in the array of qualifying withdrawals.
  withdrawalIndex: number;
  // If there are multiple messages with the same content in the tx, this should be set to the index of the message in
  // the tx's l2ToL1Msgs array.
  messageIndexInTx?: number;
}

/** Discovery adaptor: all the prover-claim policy (early submit) needs. */
export interface ProverClaimDiscoveryPortalAdaptor {
  /** Discover the prover-claimable messages in `tx`, for pricing and grouping (pre- or post-proof). */
  buildProverClaims(
    tx: ObservedTx,
    portal: ProverClaimPortalContext,
  ): ProverClaimResult[] | Promise<ProverClaimResult[]>;
}

/** Assembled claim ready to submit, or an error the collector must exclude from the batch (e.g. the burn is
 *  cut off by a freeze). */
export type BuildProverClaimResult =
  | { status: 'success'; proverClaim: ProverClaim }
  | { status: 'error'; reason: string };

/** Extends discovery with claim assembly. Required by the reward collector to submit claims. */
export interface ProverClaimPortalAdaptor extends ProverClaimDiscoveryPortalAdaptor {
  /** Assemble the data for the portal contract's `claimProverTips` call for the withdrawal at
   * `withdrawalIndex` in the tx. */
  buildProverClaimData(
    tx: TxRef,
    withdrawalIndex: number,
    proofLength: bigint,
    portal: ProverClaimPortalContext,
  ): Promise<BuildProverClaimResult>;
}

export interface ProverPortalConfig {
  context: ProverClaimPortalContext;
  adaptor: ProverClaimDiscoveryPortalAdaptor;
}

/** Portal config for the claim collector: its adaptor can also assemble claims for submission. The claim-time
 *  subsidy comes from simulating `claimProverTips`, so no subsidy quote is carried here. */
export interface ProverClaimPortalConfig extends ProverPortalConfig {
  adaptor: ProverClaimPortalAdaptor;
}

export interface DiscoveredClaim {
  portalId: string;
  checkpointNumber: CheckpointNumber;
  rewardContext: { epochNumber: EpochNumber; messageLeafIndex: bigint; pathLength: bigint; tip: bigint };
  txRef: TxRef;
  withdrawalIndex: number;
  leafId: bigint;
}
