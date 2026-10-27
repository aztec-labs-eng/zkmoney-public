import { MAX_PRIORITY_FEE_WEI } from './oxide_constants.gen.js';
import {
  type DepositBreakEvenInput,
  MAX_FEE_HEADROOM_PERCENT,
  type WithdrawalMinTipInput,
  depositBreakEvenBaseFee,
  withdrawalMinTip,
} from './relayer_break_even.js';

const E18 = 10n ** 18n;
const GWEI = 10n ** 9n;
const PRICES = { tokenWeiPerEth: 3_000n * E18, priorityFeeWei: GWEI / 20n, legacyExecutor: false };

const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
const priority = (input: WithdrawalMinTipInput | DepositBreakEvenInput) =>
  min(input.priorityFeeWei, MAX_PRIORITY_FEE_WEI);
const relayerCost = (input: WithdrawalMinTipInput | DepositBreakEvenInput, gas: bigint, baseFee: bigint) => {
  const ceiling = input.legacyExecutor ? (baseFee * (100n + MAX_FEE_HEADROOM_PERCENT)) / 100n : baseFee;
  return (gas * (ceiling + priority(input)) * input.tokenWeiPerEth + E18 - 1n) / E18;
};

function withdrawalProfitable(input: WithdrawalMinTipInput, relayerTip: bigint): boolean {
  const baseFee = input.baseFeeWei;
  const gasPrice = baseFee + priority(input);
  const { modeledTxGas: gas, startPriceWei, tokenWeiPerEth } = input;
  const quoted = gasPrice <= startPriceWei ? 0n : (gas * (gasPrice - startPriceWei) * tokenWeiPerEth) / E18;
  const payout = relayerTip + min(quoted, input.maxSubsidy, input.subsidyBalance);
  return payout >= relayerCost(input, gas, baseFee);
}

function depositProfitable(input: DepositBreakEvenInput, baseFee: bigint): boolean {
  const { sweepGas: gas, sweepTip: fee, tokenWeiPerEth } = input;
  const gasCost = (gas * (baseFee + priority(input)) * tokenWeiPerEth) / E18;
  const targetPayout = gasCost + min(input.targetRelayerProfit, fee);
  const subsidy = targetPayout <= fee ? 0n : min(targetPayout - fee, input.maxSubsidy, input.subsidyBalance);
  return fee + subsidy >= relayerCost(input, gas, baseFee);
}

function expectBreakEven(profitable: (baseFee: bigint) => boolean, breakEven: bigint, expected: bigint): void {
  expect(breakEven).toBe(expected);
  expect(profitable(breakEven)).toBe(breakEven > 0n || profitable(0n));
  expect(profitable(breakEven + 1n)).toBe(false);
}

describe('withdrawalMinTip', () => {
  const withdrawal = {
    ...PRICES,
    modeledTxGas: 125_000n,
    startPriceWei: GWEI,
    maxSubsidy: 2n * E18,
    subsidyBalance: 5n * E18,
    baseFeeWei: 10n * GWEI,
  };
  const refund = { startPriceWei: 0n };

  it.each([
    ['withdrawal: subsidy at its cap', {}, 1_768_750_000_000_000_000n],
    ['withdrawal: subsidy below its cap', { baseFeeWei: 5n * GWEI }, 375_000_000_000_000_000n],
    ['withdrawal: subsidy at the pot below its cap', { subsidyBalance: E18 / 2n }, 3_268_750_000_000_000_000n],
    ['withdrawal: base fee below the start price', { baseFeeWei: GWEI / 2n }, 206_250_000_000_000_000n],
    ['withdrawal: priority fee above MAX_PRIORITY_FEE_WEI', { priorityFeeWei: GWEI }, 1_787_500_000_000_000_000n],
    ['withdrawal: no subsidy', { maxSubsidy: 0n }, 3_768_750_000_000_000_000n],
    ['frozen notes refund', { ...refund, modeledTxGas: 1_015_000n }, 28_602_250_000_000_000_000n],
    ['frozen deposit refund', { ...refund, modeledTxGas: 1_005_000n }, 28_300_750_000_000_000_000n],
    ['unprocessed deposit refund', { ...refund, modeledTxGas: 980_000n }, 27_547_000_000_000_000_000n],
    ['refund: the subsidy pays all the gas', { ...refund, maxSubsidy: 100n * E18, subsidyBalance: 100n * E18 }, 0n],
    ['legacy withdrawal: subsidy at its cap', { legacyExecutor: true }, 5_518_750_000_000_000_000n],
    ['legacy withdrawal: zero base fee', { legacyExecutor: true, baseFeeWei: 0n }, 18_750_000_000_000_000n],
  ])('%s', (_, change, expected) => {
    const input = { ...withdrawal, ...change };
    const minTip = withdrawalMinTip(input);
    expect(minTip).toBe(expected);
    expect(withdrawalProfitable(input, minTip)).toBe(true);
    expect(minTip === 0n || !withdrawalProfitable(input, minTip - 1n)).toBe(true);
  });

  it('frozen notes refund at a fractional price: the tip covers the rounded-up gas cost', () => {
    const input = { ...withdrawal, ...refund, modeledTxGas: 1_015_000n, tokenWeiPerEth: 3_000n * E18 + 10n ** 10n };
    const minTip = withdrawalMinTip(input);
    expect(withdrawalProfitable(input, minTip)).toBe(true);
    expect(withdrawalProfitable(input, minTip - 1n)).toBe(false);
  });
});

describe('depositBreakEvenBaseFee', () => {
  const sweep = {
    ...PRICES,
    priorityFeeWei: GWEI / 100n,
    sweepGas: 354_000n,
    sweepTip: E18 / 5n,
    targetRelayerProfit: E18 / 20n,
    maxSubsidy: E18,
    subsidyBalance: 10n * E18,
  };
  const legacyProfit = { sweepTip: E18 / 10n, targetRelayerProfit: E18 / 5n };

  it.each([
    ['deposit: subsidy at its cap', {}, 1_119_943_502n],
    ['registration: subsidy at its cap', { sweepGas: 894_000n }, 437_427_293n],
    ['update metadata: subsidy at its cap', { sweepGas: 694_000n }, 566_368_876n],
    ['user op: subsidy at its cap', { sweepGas: 824_000n }, 475_436_893n],
    ['deposit: subsidy at the pot below its cap', { subsidyBalance: (4n * E18) / 10n }, 554_971_751n],
    ['deposit: higher priority fee', { priorityFeeWei: GWEI / 20n }, 1_079_943_502n],
    ['deposit: lower sweep tip', { sweepTip: E18 / 20n }, 978_700_564n],
    ['legacy deposit: the tip pays more than the subsidy', { legacyExecutor: true }, 89_161_958n],
    ['legacy deposit: the sweep tip caps the profit', { legacyExecutor: true, ...legacyProfit }, 94_161_958n],
    ['legacy deposit: subsidy below its cap', { legacyExecutor: true, sweepGas: 3_540_000n }, 4_708_097n],
  ])('%s', (_, change, expected) => {
    const input = { ...sweep, ...change };
    expectBreakEven(b => depositProfitable(input, b), depositBreakEvenBaseFee(input), expected);
  });
});
