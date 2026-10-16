import { minBigint } from '@aztec/foundation/bigint';
import { EthAddress } from '@aztec/foundation/eth-address';

import { OperationExecutorAbi } from '@oxide/l1-contracts';
import { LegacyOperationExecutorAbi } from '@oxide/l1-contracts/legacy_operation_executor.js';
import { MAX_PRIORITY_FEE_WEI } from '@oxide/oxide-lib/oxide_constants.gen.js';

import type { Address, FeeValuesEIP1559, Hex, PublicClient, StateOverride } from 'viem';

import { readUsdPerEth, weiToUSD } from './eth_usd_price_feed.js';

/**
 * The most calldata gas that a `uint256` argument adds when it changes from zero to a nonzero value: 32 bytes at 16
 * gas instead of 4.
 */
export const UINT256_EXTRA_CALLDATA_GAS = 32n * (16n - 4n);

/**
 * The calldata gas that the nonzero `gasToCover` and `tokenWeiPerEth` add to the sent `OperationExecutor.execute`.
 * Simulations and gas estimates send them as zero.
 */
export const GAS_COST_ARGS_CALLDATA_GAS = 2n * UINT256_EXTRA_CALLDATA_GAS;

/** One ETH in wei: the amount whose payout-token value is the executor's `tokenWeiPerEth`. */
export const WEI_PER_ETH = 10n ** 18n;

/**
 * Percentage by which the transaction's fee ceiling allows the latest base fee to increase before inclusion. One block
 * can raise the base fee by at most 12.5%, so 100% covers about six rising blocks.
 */
export const MAX_FEE_HEADROOM_PERCENT = 100n;

/**
 * The ETH balance a simulation gives its sender. It covers any gas charge, and it stays far below `maxUint256` so ETH
 * that the operation pays to the sender cannot overflow it: revm clients (Reth, anvil) revert such a transfer.
 */
export const SIMULATED_SENDER_BALANCE = 2n ** 128n;

/** The block that prices a quote: its fee values, its simulations and its gas estimate. */
export interface L1OperationQuoteBlock {
  number: bigint;
  baseFeePerGas: bigint | null;
}

/**
 * The gas cost that `OperationExecutor.execute` requires, in payout-token units. A copy of its
 * `Math.mulDiv(_gasToCover * tx.gasprice, _tokenWeiPerEth, 1e18, Math.Rounding.Ceil)`.
 */
export function gasCostInToken(gasToCover: bigint, gasPrice: bigint, tokenWeiPerEth: bigint): bigint {
  return (gasToCover * gasPrice * tokenWeiPerEth + WEI_PER_ETH - 1n) / WEI_PER_ETH;
}

/** `gasCostInToken` at the gas price that the transaction pays if the base fee holds: the base fee plus the tip. */
export function gasCostAtQuotePrice(
  gasToCover: bigint,
  quoteBlock: L1OperationQuoteBlock,
  feeValues: FeeValuesEIP1559,
  tokenWeiPerEth: bigint,
): bigint {
  return gasCostInToken(gasToCover, baseFeeOf(quoteBlock) + feeValues.maxPriorityFeePerGas, tokenWeiPerEth);
}

export async function estimateL1OperationFeeValues(
  client: Pick<PublicClient, 'getBlock' | 'estimateMaxPriorityFeePerGas'>,
  quoteBlock?: L1OperationQuoteBlock,
): Promise<FeeValuesEIP1559> {
  const [block, estimatedPriorityFeePerGas] = await Promise.all([
    quoteBlock ?? client.getBlock({ blockTag: 'latest' }),
    client.estimateMaxPriorityFeePerGas(),
  ]);
  const maxPriorityFeePerGas = minBigint(estimatedPriorityFeePerGas, MAX_PRIORITY_FEE_WEI);
  const maxBaseFeePerGas = (baseFeeOf(block) * (100n + MAX_FEE_HEADROOM_PERCENT)) / 100n;
  return { maxFeePerGas: maxBaseFeePerGas + maxPriorityFeePerGas, maxPriorityFeePerGas };
}

export interface SimulateL1OperationArgs {
  /** The `OperationExecutor` that the operation goes through. */
  executor: Address;
  /** `executor` has the four-argument `execute` of older deployments. It changes the simulated call, not the price. */
  legacyExecutor?: boolean;
  /** The account that sends the transaction. The simulation gives it `SIMULATED_SENDER_BALANCE`. */
  sender: Address;
  operation: { target: Address; calldata: Hex; payoutToken: Address };
  feeValues: FeeValuesEIP1559;
  /** The `minPayout` that the executor requires. */
  minPayout?: bigint;
  /** The block to simulate on, at its base fee. The latest block when omitted. */
  quoteBlock?: L1OperationQuoteBlock;
  /**
   * More state for the simulation, for state that the operation needs but that is not on L1 yet. Do not include the
   * sender. (used by zk.money).
   */
  stateOverrides?: StateOverride;
}

/**
 * Simulates `OperationExecutor.execute` with zero `gasToCover` and `tokenWeiPerEth`, with `eth_simulateV1` on top of
 * the quote block, at the base fee of that block and with the given fees. Returns the call result and `gasToCover`: the
 * gas used, plus the calldata gas of the two nonzero arguments in the sent transaction.
 */
export async function simulateL1Operation(
  client: Pick<PublicClient, 'getBlock' | 'simulateBlocks'>,
  args: SimulateL1OperationArgs,
) {
  const { executor, legacyExecutor, sender, operation, feeValues, minPayout = 0n, stateOverrides = [] } = args;
  const quoteBlock = args.quoteBlock ?? (await client.getBlock({ blockTag: 'latest' }));
  const baseFeePerGas = baseFeeOf(quoteBlock);
  const [block] = await client.simulateBlocks({
    blockNumber: quoteBlock.number,
    blocks: [
      {
        // Keep the base fee consistent with gas estimation.
        blockOverrides: { baseFeePerGas },
        stateOverrides: [{ address: sender, balance: SIMULATED_SENDER_BALANCE }, ...stateOverrides],
        calls: [
          {
            to: executor,
            ...(legacyExecutor
              ? ({
                  abi: LegacyOperationExecutorAbi,
                  functionName: 'execute',
                  args: [operation.target, operation.calldata, operation.payoutToken, minPayout],
                } as const)
              : ({
                  abi: OperationExecutorAbi,
                  functionName: 'execute',
                  args: [operation.target, operation.calldata, operation.payoutToken, minPayout, 0n, 0n],
                } as const)),
            from: sender,
            ...feeValues,
          },
        ],
      },
    ],
    traceTransfers: true,
    // Without validation, eth_simulateV1 sets BASEFEE to zero, which changes the subsidy payout.
    validation: true,
  });
  const [call] = block.calls;
  if (call.status === 'failure') {
    return call;
  }
  return {
    ...call,
    blockNumber: quoteBlock.number,
    baseFeePerGas,
    gasToCover: call.gasUsed + GAS_COST_ARGS_CALLDATA_GAS,
  };
}

/**
 * The least payout for which the relayer executes `operation` now: its gas at the quote price, the base fee of the
 * latest block plus the tip. The relayer accepts only an operation whose `payoutToken` is the 18-decimal USD underlying
 * of its portal, so `minPayout` is an amount of that token.
 *
 * Requires `payout` in the simulation so an inner failure cannot reduce the gas cost. Throws on simulation failure.
 * Returns `minPayout` in 18-decimal USD, gas used after refunds, the fees, and the ETH/USD feed answer with 8 decimals.
 */
export async function quoteL1Operation(
  client: Pick<PublicClient, 'getBlock' | 'estimateMaxPriorityFeePerGas' | 'simulateBlocks' | 'readContract'>,
  args: Omit<SimulateL1OperationArgs, 'feeValues' | 'minPayout' | 'quoteBlock'> & {
    payout: bigint;
    ethUsdFeed: Address;
  },
) {
  const { payout, ethUsdFeed, ...simulation } = args;
  const quoteBlock = await client.getBlock({ blockTag: 'latest' });
  const [feeValues, usdPerEth] = await Promise.all([
    estimateL1OperationFeeValues(client, quoteBlock),
    readUsdPerEth(client, EthAddress.fromString(ethUsdFeed)),
  ]);
  const result = await simulateL1Operation(client, { ...simulation, feeValues, minPayout: payout, quoteBlock });
  if (result.status === 'failure') {
    throw new Error(`L1 operation simulation failed: ${result.error.message}`);
  }
  return {
    ...feeValues,
    gasUsed: result.gasUsed,
    baseFeePerGas: result.baseFeePerGas,
    usdPerEth,
    minPayout: gasCostAtQuotePrice(result.gasToCover, quoteBlock, feeValues, weiToUSD(WEI_PER_ETH, usdPerEth)),
  };
}

function baseFeeOf(block: L1OperationQuoteBlock): bigint {
  if (block.baseFeePerGas === null) {
    throw new Error(`L1 block ${block.number} has no base fee`);
  }
  return block.baseFeePerGas;
}
