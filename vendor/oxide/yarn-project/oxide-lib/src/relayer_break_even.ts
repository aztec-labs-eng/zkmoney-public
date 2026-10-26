import { MAX_PRIORITY_FEE_WEI } from './oxide_constants.gen.js';

const WEI_PER_ETH = 10n ** 18n;

/**
 * Percentage by which the relayer's fee ceiling allows the latest base fee to increase before inclusion. One block can
 * raise the base fee by at most 12.5%, so 100% covers about six rising blocks.
 */
export const MAX_FEE_HEADROOM_PERCENT = 100n;

/** The prices that convert gas to the payout token. The relayer pays the base fee plus its priority fee per gas. */
export interface RelayerGasPrices {
  /** Payout-token base units per ETH, as the subsidy contracts compute it from the ETH/USD feed. */
  tokenWeiPerEth: bigint;
  /** The estimated priority fee. The relayer caps it at `MAX_PRIORITY_FEE_WEI`. */
  priorityFeeWei: bigint;
  /**
   * The `OperationExecutor` has the legacy `execute`, which checks only `minPayout`. Then the relayer requires the gas
   * at its fee ceiling: the base fee plus `MAX_FEE_HEADROOM_PERCENT`, plus the priority fee.
   */
  legacyExecutor: boolean;
}

/** A `PlainWithdrawalSubsidy` flow: its `modeledTxGas`, its `$flowPricing`, the subsidy balance, and the base fee. */
export interface WithdrawalMinTipInput extends RelayerGasPrices {
  modeledTxGas: bigint;
  startPriceWei: bigint;
  maxSubsidy: bigint;
  subsidyBalance: bigint;
  baseFeeWei: bigint;
}

/** A `DepositSubsidy` sweep: its priced gas, its `$depositConfig` values, the subsidy balance, and the SIPA's sweep tip. */
export interface DepositBreakEvenInput extends RelayerGasPrices {
  sweepGas: bigint;
  sweepTip: bigint;
  targetRelayerProfit: bigint;
  maxSubsidy: bigint;
  subsidyBalance: bigint;
}

/**
 * The lowest relayer tip, in token base units, at which the tip plus the subsidy pays the relayer's gas at `baseFeeWei`,
 * if the relayer uses `modeledTxGas`. The subsidy and the gas cost use the contract rounding. The user sets the tip of
 * each withdrawal, so the relayer pays the gas of an operation whose tip is at or above this value.
 */
export function withdrawalMinTip(input: WithdrawalMinTipInput): bigint {
  const { modeledTxGas: gas, baseFeeWei } = input;
  const gasPrice = baseFeeWei + priorityFee(input);
  const subsidy =
    gasPrice <= input.startPriceWei
      ? 0n
      : minOf(tokenAmountOf(gas, gasPrice - input.startPriceWei, input), input.maxSubsidy, input.subsidyBalance);
  const ceiling = input.legacyExecutor ? (baseFeeWei * (100n + MAX_FEE_HEADROOM_PERCENT)) / 100n : baseFeeWei;
  const cost = tokenAmountOf(gas, ceiling + priorityFee(input), input, WEI_PER_ETH - 1n);
  return maxOf(cost - subsidy, 0n);
}

/**
 * The highest base fee, in wei, at which the sweep tip plus the subsidy pays the relayer's gas, if the relayer uses the
 * priced `sweepGas`. The subsidy pays that gas at the base fee plus the priority fee, plus `targetRelayerProfit` but at
 * most the sweep tip, until its cap. Zero when the payout does not cover the priority fee. The result ignores the
 * contract rounding, so at that fee the payout can be 1 token base unit less than the gas cost.
 */
export function depositBreakEvenBaseFee(input: DepositBreakEvenInput): bigint {
  const { sweepGas: gas, sweepTip: tip } = input;
  const subsidy = minOf(input.maxSubsidy, input.subsidyBalance);
  const slack = gasPriceOf(minOf(input.targetRelayerProfit, tip), gas, input);
  return breakEvenBaseFee({ gas, tip, subsidy, slack }, input);
}

/**
 * The payout is the tip plus the uncapped subsidy, but at least the tip and at most the tip plus `subsidy`. `slack` is
 * the gas price, in wei, by which the tip plus the uncapped subsidy exceeds the gas cost at a zero base fee.
 */
interface Payout {
  gas: bigint;
  tip: bigint;
  subsidy: bigint;
  slack: bigint;
}

function breakEvenBaseFee(payout: Payout, prices: RelayerGasPrices): bigint {
  const tipOnly = baseFeeFor(payout.tip, payout.gas, prices);
  const capped = baseFeeFor(payout.tip + payout.subsidy, payout.gas, prices);
  const result = minOf(maxOf(uncappedLimit(payout.slack, capped, prices), tipOnly), capped);
  return maxOf(result, 0n);
}

function uncappedLimit(slack: bigint, capped: bigint, prices: RelayerGasPrices): bigint {
  if (!prices.legacyExecutor) {
    return slack >= 0n ? capped : 0n;
  }
  return maxOf((slack * 100n) / MAX_FEE_HEADROOM_PERCENT, 0n);
}

function baseFeeFor(amount: bigint, gas: bigint, prices: RelayerGasPrices): bigint {
  const percent = prices.legacyExecutor ? 100n + MAX_FEE_HEADROOM_PERCENT : 100n;
  return ((gasPriceOf(amount, gas, prices) - priorityFee(prices)) * 100n) / percent;
}

function gasPriceOf(amount: bigint, gas: bigint, prices: RelayerGasPrices): bigint {
  return (amount * WEI_PER_ETH) / (gas * prices.tokenWeiPerEth);
}

function tokenAmountOf(gas: bigint, gasPrice: bigint, prices: RelayerGasPrices, roundUp = 0n): bigint {
  return (gas * gasPrice * prices.tokenWeiPerEth + roundUp) / WEI_PER_ETH;
}

function priorityFee(prices: RelayerGasPrices): bigint {
  return minOf(prices.priorityFeeWei, MAX_PRIORITY_FEE_WEI);
}

function minOf(...values: bigint[]): bigint {
  return values.reduce((a, b) => (a < b ? a : b));
}

function maxOf(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
