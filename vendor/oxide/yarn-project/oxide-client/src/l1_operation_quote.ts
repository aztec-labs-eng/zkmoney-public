import { minBigint } from '@aztec-labs/foundation/bigint';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { OperationExecutorAbi } from '@oxide/l1-contracts';
import {
  LegacyOperationExecutorAbi,
  type OperationExecutorVersion,
  readOperationExecutorVersion,
} from '@oxide/l1-contracts/legacy_operation_executor.js';
import { MAX_PRIORITY_FEE_WEI } from '@oxide/oxide-lib/oxide_constants.gen.js';
import { MAX_FEE_HEADROOM_PERCENT } from '@oxide/oxide-lib/relayer_break_even.js';

import {
  type Address,
  type FeeValuesEIP1559,
  type Hex,
  type PublicClient,
  type StateOverride,
  encodeFunctionData,
} from 'viem';

import { readUsdPerEth, weiToUSD } from './eth_usd_price_feed.js';

/**
 * The most calldata gas that a `uint256` argument adds when it changes from zero to a nonzero value: 32 bytes at 16
 * gas instead of 4.
 */
export const UINT256_EXTRA_CALLDATA_GAS = 32n * (16n - 4n);

/**
 * The calldata gas that the nonzero `gasToCover` and `tokenWeiPerEth` add to the sent `OperationExecutor.execute`.
 * The simulations send them as zero.
 */
export const GAS_COST_ARGS_CALLDATA_GAS = 2n * UINT256_EXTRA_CALLDATA_GAS;

/** One ETH in wei: the amount whose payout-token value is the executor's `tokenWeiPerEth`. */
export const WEI_PER_ETH = 10n ** 18n;

/**
 * The most gas that one transaction can use (EIP-7825). Above it, an RPC node can execute a call with a different gas
 * price, so a subsidy that prices gas at `tx.gasprice` pays a different amount than in the sent transaction.
 */
export const MAX_TRANSACTION_GAS = 2n ** 24n;

/**
 * Explicit gas for eth_simulateV1; Sepolia RPCs reject an omitted gas limit under validation. It is less than
 * {@link MAX_TRANSACTION_GAS}, so each simulation gets the payout that the sent transaction gets.
 */
const MAX_SIMULATION_GAS = 15_000_000n;

export { MAX_FEE_HEADROOM_PERCENT };

/**
 * The ETH balance a simulation gives its sender. It covers any gas charge, and it stays far below `maxUint256` so ETH
 * that the operation pays to the sender cannot overflow it: revm clients (Reth, anvil) revert such a transfer.
 */
export const SIMULATED_SENDER_BALANCE = 2n ** 128n;

/**
 * The `execute` of an `OperationExecutor` deployed before the executor priced the gas cost. It takes only `minPayout`.
 * Manifest entries keep the executor that they were deployed with, so the relayer still calls this version.
 */
export const LEGACY_OPERATION_EXECUTOR_ABI = LegacyOperationExecutorAbi;

export { type OperationExecutorVersion, readOperationExecutorVersion };

/** The arguments of `execute` that only the `gas-to-cover` executor takes. */
export interface ExecuteGasCostArgs {
  gasToCover: bigint;
  tokenWeiPerEth: bigint;
}

/** No gas to cover, so the executor checks only the `minPayout` argument. */
export const NO_EXECUTE_GAS_COST: ExecuteGasCostArgs = { gasToCover: 0n, tokenWeiPerEth: 0n };

/**
 * `execute` calldata for an executor of `version`. A `legacy` executor cannot check a gas cost, so it requires
 * `NO_EXECUTE_GAS_COST`: give its floor in `minPayout`.
 */
export function encodeOperationExecute(
  version: OperationExecutorVersion,
  operation: { target: Address; calldata: Hex; payoutToken: Address },
  minPayout: bigint,
  gasCostArgs: ExecuteGasCostArgs = NO_EXECUTE_GAS_COST,
): Hex {
  const { target, calldata, payoutToken } = operation;
  if (version === 'legacy') {
    if (gasCostArgs.gasToCover !== 0n || gasCostArgs.tokenWeiPerEth !== 0n) {
      throw new Error('a legacy OperationExecutor takes no gas cost; give the floor in minPayout');
    }
    return encodeFunctionData({
      abi: LEGACY_OPERATION_EXECUTOR_ABI,
      functionName: 'execute',
      args: [target, calldata, payoutToken, minPayout],
    });
  }
  return encodeFunctionData({
    abi: OperationExecutorAbi,
    functionName: 'execute',
    args: [target, calldata, payoutToken, minPayout, gasCostArgs.gasToCover, gasCostArgs.tokenWeiPerEth],
  });
}

/** The block that prices a quote: its fee values and its simulations. */
export interface L1OperationQuoteBlock {
  number: bigint;
  baseFeePerGas: bigint | null;
  /** Caps the simulation's explicit gas when set. */
  gasLimit?: bigint;
}

/**
 * The gas cost that `OperationExecutor.execute` requires, in payout-token units. A copy of its
 * `Math.mulDiv(_gasToCover * tx.gasprice, _tokenWeiPerEth, 1e18, Math.Rounding.Ceil)`.
 */
export function gasCostInToken(gasToCover: bigint, gasPrice: bigint, tokenWeiPerEth: bigint): bigint {
  return (gasToCover * gasPrice * tokenWeiPerEth + WEI_PER_ETH - 1n) / WEI_PER_ETH;
}

/** The gas limit of a simulation that sets none: the gas limit of the quote block, capped at 15M gas. */
export function simulationGasLimit(quoteBlock: L1OperationQuoteBlock): bigint {
  return quoteBlock.gasLimit === undefined ? MAX_SIMULATION_GAS : minBigint(quoteBlock.gasLimit, MAX_SIMULATION_GAS);
}

/**
 * The first gas limit for a call that used `gasUsed` after refunds in a simulation: 3/2 of it, capped at
 * {@link simulationGasLimit}. The gas before refunds is at most 5/4 of the gas after them (EIP-3529). The rest covers
 * the gas that the 63/64 rule keeps back in nested calls. A simulation at this limit confirms it. If that simulation
 * fails, {@link nextL1OperationGasLimit} gives the next limit to try.
 */
export function l1OperationGasLimit(gasUsed: bigint, quoteBlock: L1OperationQuoteBlock): bigint {
  return minBigint((gasUsed * 3n) / 2n, simulationGasLimit(quoteBlock));
}

/**
 * The gas limit to try after a simulation at `gasLimit` failed: twice it, capped at {@link simulationGasLimit}.
 * Undefined when `gasLimit` is at the cap already. A target can require more gas left than it uses, for example an
 * ERC-4337 EntryPoint that requires the gas limits of a user operation.
 */
export function nextL1OperationGasLimit(gasLimit: bigint, quoteBlock: L1OperationQuoteBlock): bigint | undefined {
  const cap = simulationGasLimit(quoteBlock);
  return gasLimit >= cap ? undefined : minBigint(gasLimit * 2n, cap);
}

/**
 * The least gas to cover for a transaction with `gasLimit`: 2/3 of it, rounded up. The target can use all of the gas
 * limit in the sent transaction, also when it used less in each simulation. With this floor, the gas that the payout
 * does not cover is at most half of the gas that it covers. At the first gas limit, the floor is not more than the
 * simulated gas to cover.
 */
export function minGasToCover(gasLimit: bigint): bigint {
  return (gasLimit * 2n + 2n) / 3n;
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
  /** The `execute` version of `executor`. Default to `gas-to-cover`, or to `legacy` when `legacyExecutor` is set. */
  executorVersion?: OperationExecutorVersion;
  /** `executor` has the four-argument `execute` of older deployments. The same as `executorVersion: 'legacy'`. */
  legacyExecutor?: boolean;
  /** The account that sends the transaction. The simulation gives it `SIMULATED_SENDER_BALANCE`. */
  sender: Address;
  operation: { target: Address; calldata: Hex; payoutToken: Address };
  feeValues: FeeValuesEIP1559;
  /** The `minPayout` that the executor requires. */
  minPayout?: bigint;
  /** The block to simulate on, at its base fee. The latest block when omitted. */
  quoteBlock?: L1OperationQuoteBlock;
  /** The gas limit of the simulated call. The gas of {@link simulationGasLimit} when omitted. */
  gas?: bigint;
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
  const { executor, sender, operation, feeValues, minPayout = 0n, stateOverrides = [] } = args;
  const executorVersion = executorVersionOf(args);
  const quoteBlock = args.quoteBlock ?? (await client.getBlock({ blockTag: 'latest' }));
  const baseFeePerGas = baseFeeOf(quoteBlock);
  const gas = args.gas ?? simulationGasLimit(quoteBlock);
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
            ...executeCall(executorVersion, operation, minPayout),
            from: sender,
            gas,
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
 * The gas cost that the relayer requires before it sends an operation. A `gas-to-cover` executor prices the gas at the
 * gas price that the transaction pays, so the relayer decides at the quote price. A `legacy` executor requires a fixed
 * `minPayout`, so the relayer sets it to the gas at `maxFeePerGas`, which the transaction never exceeds.
 */
export function relayerGasCost(
  version: OperationExecutorVersion,
  gasToCover: bigint,
  quoteBlock: L1OperationQuoteBlock,
  feeValues: FeeValuesEIP1559,
  tokenWeiPerEth: bigint,
): bigint {
  return version === 'legacy'
    ? gasCostInToken(gasToCover, feeValues.maxFeePerGas, tokenWeiPerEth)
    : gasCostAtQuotePrice(gasToCover, quoteBlock, feeValues, tokenWeiPerEth);
}

/**
 * The least payout for which the relayer executes `operation` now: its gas at the quote price, the base fee of the
 * latest block plus the tip. For a `legacy` executor, its gas at `maxFeePerGas`. The relayer accepts only an operation
 * whose `payoutToken` is the 18-decimal USD underlying of its portal, so `minPayout` is an amount of that token.
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
    minPayout: relayerGasCost(
      executorVersionOf(args),
      result.gasToCover,
      quoteBlock,
      feeValues,
      weiToUSD(WEI_PER_ETH, usdPerEth),
    ),
  };
}

function executorVersionOf(
  args: Pick<SimulateL1OperationArgs, 'executorVersion' | 'legacyExecutor'>,
): OperationExecutorVersion {
  return args.executorVersion ?? (args.legacyExecutor ? 'legacy' : 'gas-to-cover');
}

/** The `execute` call that `simulateL1Operation` makes, with no gas cost. */
function executeCall(
  version: OperationExecutorVersion,
  operation: SimulateL1OperationArgs['operation'],
  minPayout: bigint,
) {
  const { target, calldata, payoutToken } = operation;
  return version === 'legacy'
    ? ({
        abi: LEGACY_OPERATION_EXECUTOR_ABI,
        functionName: 'execute',
        args: [target, calldata, payoutToken, minPayout],
      } as const)
    : ({
        abi: OperationExecutorAbi,
        functionName: 'execute',
        args: [target, calldata, payoutToken, minPayout, 0n, 0n],
      } as const);
}

function baseFeeOf(block: L1OperationQuoteBlock): bigint {
  if (block.baseFeePerGas === null) {
    throw new Error(`L1 block ${block.number} has no base fee`);
  }
  return block.baseFeePerGas;
}
