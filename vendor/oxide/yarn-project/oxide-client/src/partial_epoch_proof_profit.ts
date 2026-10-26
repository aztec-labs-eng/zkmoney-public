import { weiToUSD } from './eth_usd_price_feed.js';

/**
 * Gas of one epoch proof submission through the FirstProverProofSubmitter: a part every proof pays and a part for
 * each checkpoint it covers. The fixed part is the Honk verification, the committee attestations, the blob point
 * evaluation and the submitter's proven-tip check. Each checkpoint adds its header in calldata, the check of that
 * header against its stored hash, its public inputs and its turn in the reward loop.
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
 * The FirstProverProofSubmitter's proven-tip check costs about 21k, so the base is about 37k above the cost of a
 * proof through it.
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

/** Gas of one `claimProverTips` transaction on a portal. */
export interface ClaimProverTipsGasModel {
  baseGas: bigint;
  gasPerClaim: bigint;
}

/**
 * Estimated from the trace of a one-claim `claimProverTips` in the portal's unit tests: about 107k gas for the claim
 * and 6k for the subsidy payout, against a mock rollup and outbox. The model adds the intrinsic gas, the claim
 * calldata and the cold reads of the real rollup, outbox and subsidy token. Calibrate it against claim receipts.
 */
export const PORTAL__CLAIM_PROVER_TIPS_GAS_MODEL: ClaimProverTipsGasModel = {
  baseGas: 60_000n,
  gasPerClaim: 130_000n,
};

/** Gas of one `claimProverTips` transaction with `claimCount` claims. A portal with no claims sends no transaction. */
export function claimProverTipsGas(
  claimCount: bigint,
  model: ClaimProverTipsGasModel = PORTAL__CLAIM_PROVER_TIPS_GAS_MODEL,
): bigint {
  return claimCount === 0n ? 0n : model.baseGas + model.gasPerClaim * claimCount;
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
  /** Cost of the gas of the proof submission and of the claim transactions. */
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

export interface PortalTokenPrice {
  /** USD per whole token, scaled to 18 decimals. */
  usdPerToken: bigint;
  /** Decimals of the token itself. */
  decimals: number;
}

/** One USD per whole token of 18 decimals: a USD-pegged token such as DAI. */
export const PAR_TOKEN_PRICE: PortalTokenPrice = { usdPerToken: 10n ** 18n, decimals: 18 };

export interface ProverTipQuoteInput extends Partial<PartialEpochProofTerms> {
  /** The per-gas price the proof submission and the claim transaction are expected to pay. */
  gasPriceWei: bigint;
  /** ETH/USD feed answer, scaled by `10**ETH_USD_FEED_DECIMALS`. */
  usdPerEth: bigint;
  /** The prover subsidy's quote for one claim, in units of the portal token. */
  subsidyForOneClaim: bigint;
  /**
   * Checkpoints the proof covers, the initiation's checkpoint included: its one-based index in the epoch. Sets gas and
   * proving cost.
   */
  checkpointCount: bigint;
  /** Default to {@link ROLLUP__SUBMIT_EPOCH_PROOF_GAS_MODEL}. */
  submitEpochProofGasModel?: SubmitEpochProofGasModel;
  /** Default to {@link PORTAL__CLAIM_PROVER_TIPS_GAS_MODEL}. */
  claimProverTipsGasModel?: ClaimProverTipsGasModel;
  /**
   * The price that the relayer gives to the portal token. Default to {@link PAR_TOKEN_PRICE}. Give it for a token that
   * is not worth one USD, for example a vault share such as sUSDS, which the relayer values at the vault rate.
   */
  tokenPrice?: PortalTokenPrice;
}

/**
 * The smallest prover tip that makes the relayer submit an early proof for one withdrawal, when it is the only claim
 * the proof captures. The tip pays for the proof submission and for the claim transaction that collects it. The tip
 * is in units of the portal's underlying token, valued at `tokenPrice`. Terms that are not given default to the
 * relayer defaults.
 *
 * Throws when the margin is 100% or more: then no tip meets the rule.
 */
export function quoteProverTip(input: ProverTipQuoteInput): bigint {
  const minEpochProfit = input.minEpochProfit ?? EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT;
  const marginBps = input.minEpochProfitMarginBps ?? EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT_MARGIN_BPS;
  const provingCostPerCheckpoint = input.provingCostPerCheckpoint ?? EARLY_SUBMIT_POLICY__PROVING_COST_PER_CHECKPOINT;
  const gas =
    submitEpochProofGas(input.checkpointCount, input.submitEpochProofGasModel) +
    claimProverTipsGas(1n, input.claimProverTipsGasModel);
  if (marginBps >= BPS_DENOMINATOR) {
    throw new Error(`no prover tip meets a min epoch profit margin of ${marginBps} bps`);
  }

  const cost = weiToUSD(gas * input.gasPriceWei, input.usdPerEth) + provingCostPerCheckpoint * input.checkpointCount;
  // The margin rule `(reward − cost) * BPS_DENOMINATOR >= reward * marginBps` solves to
  // `reward >= cost * BPS_DENOMINATOR / (BPS_DENOMINATOR − marginBps)`.
  const marginDenominator = BPS_DENOMINATOR - marginBps;
  const minRewardForMargin = cost > 0n ? (cost * BPS_DENOMINATOR + marginDenominator - 1n) / marginDenominator : 0n;
  const minReward = maxBigInt(cost + minEpochProfit, minRewardForMargin);
  // The prover values the tip and the subsidy together and rounds the value down. So the smallest token amount that
  // is worth `minReward` rounds up.
  const { usdPerToken, decimals } = input.tokenPrice ?? PAR_TOKEN_PRICE;
  const tokenScale = 10n ** BigInt(decimals);
  const minRewardTokens = (minReward * tokenScale + usdPerToken - 1n) / usdPerToken;
  return maxBigInt(0n, minRewardTokens - input.subsidyForOneClaim);
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
