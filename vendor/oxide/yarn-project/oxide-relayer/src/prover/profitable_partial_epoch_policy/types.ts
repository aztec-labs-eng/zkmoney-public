import { ProverPortalConfig } from '../prover_claim_lib/index.js';

export type { ObservedTx, PortalContext } from '../types.js';

export type {
  PartialProofDecision,
  PartialProofPolicy,
  PartialProofPolicyInput,
} from '../partial_epoch_proof_starter/types.js';

export type {
  ProverClaimResult,
  ProverClaimDiscoveryPortalAdaptor,
  ProverPortalConfig,
  DiscoveredClaim,
} from '../prover_claim_lib/index.js';

/**
 * Portal config for the early-submit policy: discovery plus the forward-looking subsidy quote. The prover subsidy
 * pays a flat rate per prover claim, so the quote depends only on the claim count and is known before the epoch is
 * proven.
 * TODO(benesjan): This type seems stupid. Clean up post v1.
 */
export interface EarlySubmitPortalConfig extends ProverPortalConfig {
  /** The flat subsidy the prover subsidy pays for `numClaims` prover claims. */
  quoteProverSubsidy: (numClaims: bigint) => Promise<bigint>;
}

// TODO(benesjan): Fix the incosistent naming here. No reason to call it EarlySubmitPolicy once and
// ProfitablePartialEpochPolicy the second time.
export interface EarlySubmitPolicy {
  // Absolute profit floor for an early (partial-epoch) proof submission, in USD scaled to 18 decimals. The
  // policy submits only when the estimated net profit (reward value − gas cost value − proving cost value) meets both
  // this floor and minEpochProfitMarginBps.
  // Default to config.EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT.
  minEpochProfit: bigint;
  // Relative profit floor in basis points, measured against reward value. It stops a large epoch from passing on a
  // profit that is absolutely above minEpochProfit but tiny relative to the value at stake.
  // Default to config.EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT_MARGIN_BPS.
  minEpochProfitMarginBps: bigint;
  // Off-chain proving cost per checkpoint, in USD scaled to 18 decimals.
  // Default to config.EARLY_SUBMIT_POLICY__PROVING_COST_PER_CHECKPOINT.
  provingCostPerCheckpoint: bigint;
}

/**
 * Aggregate profit of claiming the prover-tipped messages across a fed range of checkpoints. Every value is USD
 * scaled to 18 decimals: the price oracle values the gas in ETH and each reward in the token of the portal that
 * pays it.
 */
export interface ProverProfitEstimate {
  // Net profit: total reward value − total gas cost value − proving cost value.
  profit: bigint;
  // Prover tips + subsidy across the counted claims, valued in USD at the price of each portal's token.
  rewardValue: bigint;
  // Cost of the gas of the epoch proof submission and of the claim transactions, valued in USD.
  gasCostValue: bigint;
  // Off-chain proving cost: per-checkpoint cost times the proven prefix length, in USD.
  provingCostValue: bigint;
  // Gas units of the epoch proof submission and of the claim transactions.
  gas: bigint;
  // Number of counted claims. A claim whose reward does not pay for its gas at the max fee per gas is not counted.
  claimCount: number;
}
