import { minBigint } from '@aztec/foundation/bigint';
import { EthAddress } from '@aztec/foundation/eth-address';

import { OperationExecutorAbi } from '@oxide/l1-contracts';
import { MAX_PRIORITY_FEE_WEI } from '@oxide/oxide-lib/oxide_constants.gen.js';

import { type Address, type FeeValuesEIP1559, type Hex, type PublicClient, type StateOverride, maxUint256 } from 'viem';

import { readUsdPerEth, weiToUSD } from './eth_usd_price_feed.js';

/**
 * Gas to add to an executor gas estimate or the gas used in a simulation. The sent `minPayout` can have more non-zero bytes
 * than the simulated value, which adds at most 32 * (16 - 4) = 384 gas to the calldata.
 */
export const EXECUTOR_MIN_PAYOUT_CALLDATA_GAS = 384n;

/**
 * Default percentage by which the transaction's fee ceiling allows the latest base fee to increase before inclusion.
 * The break-even payout is priced at this ceiling.
 */
export const DEFAULT_MAX_FEE_HEADROOM_PERCENT = 6.25;

/**
 * The fees the relayer signs an L1 operation with. `maxFeePerGas` is the latest base fee increased by
 * `headroomPercent`, plus the tip. The headroom applies only to the base fee, because the tip does not change before
 * inclusion. The tip is the `eth_maxPriorityFeePerGas` estimate, capped at `MAX_PRIORITY_FEE_WEI`, the tip that
 * subsidy pays for.
 */
export async function estimateL1OperationFeeValues(
  client: Pick<PublicClient, 'getBlock' | 'estimateMaxPriorityFeePerGas'>,
  headroomPercent: number = DEFAULT_MAX_FEE_HEADROOM_PERCENT,
): Promise<FeeValuesEIP1559> {
  const [latestBlock, estimatedPriorityFeePerGas] = await Promise.all([
    client.getBlock({ blockTag: 'latest' }),
    client.estimateMaxPriorityFeePerGas(),
  ]);
  const maxPriorityFeePerGas = minBigint(estimatedPriorityFeePerGas, MAX_PRIORITY_FEE_WEI);
  const headroomBps = BigInt(Math.round(headroomPercent * 100));
  const maxBaseFeePerGas = ((latestBlock.baseFeePerGas ?? 0n) * (10_000n + headroomBps)) / 10_000n;
  return { maxFeePerGas: maxBaseFeePerGas + maxPriorityFeePerGas, maxPriorityFeePerGas };
}

export interface SimulateL1OperationArgs {
  /** The `OperationExecutor` that the operation goes through. */
  executor: Address;
  /** The account that sends the transaction. The simulation gives it an unlimited ETH balance. */
  sender: Address;
  operation: { target: Address; calldata: Hex; payoutToken: Address };
  feeValues: FeeValuesEIP1559;
  /** The `minPayout` that the executor requires. */
  minPayout?: bigint;
  /**
   * More state for the simulation, for state that the operation needs but that is not on L1 yet. Do not include the
   * sender. (used by zk.money).
   */
  stateOverrides?: StateOverride;
}

/**
 * Simulates `OperationExecutor.execute` with `eth_simulateV1` on top of the latest block, at the base fee of that
 * block and with the given fees. Returns the call result and its cost at the fee ceiling, with calldata gas padding.
 */
export async function simulateL1Operation(
  client: Pick<PublicClient, 'getBlock' | 'simulateBlocks'>,
  args: SimulateL1OperationArgs,
) {
  const { executor, sender, operation, feeValues, minPayout = 0n, stateOverrides = [] } = args;
  const latestBlock = await client.getBlock({ blockTag: 'latest' });
  const baseFeePerGas = latestBlock.baseFeePerGas ?? 0n;
  const [block] = await client.simulateBlocks({
    blockNumber: latestBlock.number,
    blocks: [
      {
        // Keep the base fee consistent with gas estimation.
        blockOverrides: { baseFeePerGas },
        stateOverrides: [{ address: sender, balance: maxUint256 }, ...stateOverrides],
        calls: [
          {
            to: executor,
            abi: OperationExecutorAbi,
            functionName: 'execute',
            args: [operation.target, operation.calldata, operation.payoutToken, minPayout],
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
    blockNumber: latestBlock.number,
    baseFeePerGas,
    costWei: (call.gasUsed + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS) * feeValues.maxFeePerGas,
  };
}

/**
 * The least payout for which the relayer executes `operation` now. The relayer accepts only an operation whose
 * `payoutToken` is the 18-decimal USD underlying of its portal, so `minPayout` is an amount of that token.
 *
 * Requires `payout` in the simulation so an inner failure cannot reduce the gas cost. Throws on simulation failure.
 * Returns `minPayout` in 18-decimal USD, gas used after refunds, the fees, and the ETH/USD feed answer with 8 decimals.
 */
export async function quoteL1Operation(
  client: Pick<PublicClient, 'getBlock' | 'estimateMaxPriorityFeePerGas' | 'simulateBlocks' | 'readContract'>,
  args: Omit<SimulateL1OperationArgs, 'feeValues' | 'minPayout'> & {
    payout: bigint;
    ethUsdFeed: Address;
    headroomPercent?: number;
  },
) {
  const { payout, ethUsdFeed, headroomPercent, ...simulation } = args;
  const [feeValues, usdPerEth] = await Promise.all([
    estimateL1OperationFeeValues(client, headroomPercent),
    readUsdPerEth(client, EthAddress.fromString(ethUsdFeed)),
  ]);
  const result = await simulateL1Operation(client, { ...simulation, feeValues, minPayout: payout });
  if (result.status === 'failure') {
    throw new Error(`L1 operation simulation failed: ${result.error.message}`);
  }
  return {
    ...feeValues,
    gasUsed: result.gasUsed,
    baseFeePerGas: result.baseFeePerGas,
    usdPerEth,
    minPayout: weiToUSD(result.costWei, usdPerEth),
  };
}
