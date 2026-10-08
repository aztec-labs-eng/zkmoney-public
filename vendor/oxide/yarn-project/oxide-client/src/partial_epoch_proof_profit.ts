import { weiToUSD } from './eth_usd_price_feed.js';

/**
 * Gas of one epoch proof submission through the FirstProverProofSubmitter: a part every proof pays and a part for
 * each checkpoint it covers. The fixed part is the Honk verification, the committee attestations, the blob point
 * evaluation and the first-prover capture. Each checkpoint adds its header in calldata, the check of that header
 * against its stored hash, its public inputs and its turn in the reward loop.
 */
export interface SubmitEpochProofGasModel {
  baseGas: bigint;
  gasPerCheckpoint: bigint;
}

/**
 * The base is fitted to the receipts of the Aztec v5 rollups' `L2ProofVerified` transactions, with the submitter's
 * capture (about 58k) added where a proof paid none and 33 of 48 committee signatures in each: mainnet, 52 first
 * proofs of 24 to 32 checkpoints, 1.49M + 22.1k per checkpoint; Sepolia testnet, 52 of 8 to 32, 1.53M + 18.4k. The
 * per-checkpoint gas is the rollup benchmark's with the mock verifier (661k at 1 checkpoint, 980k at 8, 1.29M at 16,
 * 1.80M at 32), where every sequencer's reward slot is written cold; mainnet sequencers mostly hold a balance, so
 * the chain's slope is 15k lower. A proof that extends an epoch already partly proven costs less, so it is left out.
 */
export const ROLLUP__SUBMIT_EPOCH_PROOF_GAS_MODEL: SubmitEpochProofGasModel = {
  baseGas: 1_500_000n,
  gasPerCheckpoint: 37_000n,
};

/** Gas of a proof that covers `checkpointCount` checkpoints. */
export function submitEpochProofGas(
  checkpointCount: bigint,
  model: SubmitEpochProofGasModel = ROLLUP__SUBMIT_EPOCH_PROOF_GAS_MODEL,
): bigint {
  return model.baseGas + model.gasPerCheckpoint * checkpointCount;
}

export const EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT = 0n;
export const EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT_MARGIN_BPS = 0n;

// Off-chain proving cost per checkpoint, in the price oracle's common quote currency.
export const EARLY_SUBMIT_POLICY__PROVING_COST_PER_CHECKPOINT = 0n;

export const BPS_DENOMINATOR = 10_000n;

/** The relayer's terms for an early (partial-epoch) proof. All values are in the price oracle's quote currency. */
export interface PartialEpochProofTerms {
  minEpochProfit: bigint;
  minEpochProfitMarginBps: bigint;
  provingCostPerCheckpoint: bigint;
}

export interface PartialEpochProofProfitInput extends PartialEpochProofTerms {
  /** Prover tips plus prover subsidy of the claims the proof captures. */
  rewardValue: bigint;
  /** Cost of the proof submission gas. */
  gasCostValue: bigint;
  /** Number of checkpoints the proof covers. */
  checkpointCount: bigint;
}

export interface PartialEpochProofProfit {
  /** rewardValue − gasCostValue − provingCostValue. */
  profit: bigint;
  provingCostValue: bigint;
  /** True when the profit meets both the absolute floor and the margin floor. */
  profitable: boolean;
}

/** The relayer's rule for an early proof: submit only when the profit meets both floors in the terms. */
export function computePartialEpochProofProfit(input: PartialEpochProofProfitInput): PartialEpochProofProfit {
  const provingCostValue = input.provingCostPerCheckpoint * input.checkpointCount;
  const profit = input.rewardValue - input.gasCostValue - provingCostValue;
  const profitable =
    profit >= input.minEpochProfit && profit * BPS_DENOMINATOR >= input.rewardValue * input.minEpochProfitMarginBps;
  return { profit, provingCostValue, profitable };
}

export interface ProverTipQuoteInput extends Partial<PartialEpochProofTerms> {
  /** The per-gas price the proof submission is expected to pay. */
  gasPriceWei: bigint;
  /** ETH/USD feed answer, scaled by `10**ETH_USD_FEED_DECIMALS`. */
  usdPerEth: bigint;
  /** The prover subsidy's quote for one claim. */
  subsidyForOneClaim: bigint;
  /** Checkpoints the proof covers, the burn's included: its one-based index in the epoch. Sets gas and proving cost. */
  checkpointCount: bigint;
  /** Default to {@link ROLLUP__SUBMIT_EPOCH_PROOF_GAS_MODEL}. */
  submitEpochProofGasModel?: SubmitEpochProofGasModel;
}

/**
 * The smallest prover tip that makes the relayer submit an early proof for one withdrawal, when it is the only claim
 * the proof captures. The tip is in the 18-decimal units of the portal's underlying token. The relayer values the
 * underlying at par with USD, so this quote does the same. Terms that are not given default to the relayer defaults.
 *
 * Throws when the margin is 100% or more: then no tip meets the rule.
 */
export function quoteProverTip(input: ProverTipQuoteInput): bigint {
  const minEpochProfit = input.minEpochProfit ?? EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT;
  const marginBps = input.minEpochProfitMarginBps ?? EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT_MARGIN_BPS;
  const provingCostPerCheckpoint = input.provingCostPerCheckpoint ?? EARLY_SUBMIT_POLICY__PROVING_COST_PER_CHECKPOINT;
  const gas = submitEpochProofGas(input.checkpointCount, input.submitEpochProofGasModel);
  if (marginBps >= BPS_DENOMINATOR) {
    throw new Error(`no prover tip meets a min epoch profit margin of ${marginBps} bps`);
  }

  const cost = weiToUSD(gas * input.gasPriceWei, input.usdPerEth) + provingCostPerCheckpoint * input.checkpointCount;
  // The margin rule `(reward − cost) * BPS_DENOMINATOR >= reward * marginBps` solves to
  // `reward >= cost * BPS_DENOMINATOR / (BPS_DENOMINATOR − marginBps)`.
  const marginDenominator = BPS_DENOMINATOR - marginBps;
  const minRewardForMargin = cost > 0n ? (cost * BPS_DENOMINATOR + marginDenominator - 1n) / marginDenominator : 0n;
  const minReward = maxBigInt(cost + minEpochProfit, minRewardForMargin);
  return maxBigInt(0n, minReward - input.subsidyForOneClaim);
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
