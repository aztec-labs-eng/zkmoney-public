import { type AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';

import { StablecoinWithdrawalExecutorAbi } from '@oxide/l1-contracts/artifacts.js';
import { MAINNET_DAI, MAINNET_USDC, MAINNET_USDT } from '@oxide/l1-contracts/deposit_tokens.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';
import {
  StablecoinWithdrawalRoute,
  assertStablecoinWithdrawalTip,
  encodeStablecoinWithdrawalPayload,
  stablecoinWithdrawalNetAmount,
} from '@oxide/oxide-lib/stablecoin_withdrawal_executor.js';

import type { Hex, PublicClient } from 'viem';

import type { WithdrawOperation } from '../l2_operations.js';
import type { FinalizationRequestBroadcastParams } from '../withdrawal_finalization_request.js';
import type { WithdrawalExecutor } from './plain_withdrawal_executor.js';

/** Reads the fee that `executor` takes from each withdrawal */
export function readStablecoinWithdrawalFee(
  client: Pick<PublicClient, 'readContract'>,
  executor: EthAddress,
): Promise<bigint> {
  return client.readContract({
    address: executor.toString(),
    abi: StablecoinWithdrawalExecutorAbi,
    functionName: 'FEE',
  });
}

/** Reads the fee that `executor` takes from each withdrawal and the asset that it pays. */
export async function readStablecoinWithdrawalExecutor(
  client: Pick<PublicClient, 'readContract'>,
  executor: EthAddress,
): Promise<StablecoinWithdrawalExecutor> {
  const [fee, asset] = await Promise.all([
    readStablecoinWithdrawalFee(client, executor),
    client.readContract({ address: executor.toString(), abi: StablecoinWithdrawalExecutorAbi, functionName: 'ASSET' }),
  ]);
  return { address: executor, fee, asset: EthAddress.fromString(asset) };
}

/** A stablecoin withdrawal executor, the fee that it takes from each withdrawal and the asset that it pays. */
export interface StablecoinWithdrawalExecutor extends WithdrawalExecutor {
  asset: EthAddress;
}

/** The mainnet stablecoins that a stablecoin withdrawal from the DAI portal can pay. */
export const STABLECOIN_OUTPUT_TOKENS = [MAINNET_DAI, MAINNET_USDC, MAINNET_USDT] as const;

const STABLECOIN_ROUTES: readonly [EthAddress, StablecoinWithdrawalRoute][] = [
  [MAINNET_DAI, StablecoinWithdrawalRoute.DAI],
  [MAINNET_USDC, StablecoinWithdrawalRoute.USDC],
  [MAINNET_USDT, StablecoinWithdrawalRoute.USDT],
];

/** The most `daiForGas` of one withdrawal. */
export const MAX_DAI_FOR_GAS = 50n * 10n ** 18n;

export interface StablecoinWithdrawalArgs {
  from: AztecAddress;
  /** The deployment's `StablecoinWithdrawalExecutor`. */
  executor: StablecoinWithdrawalExecutor;
  recipient: EthAddress;
  /** The executor pays it to the relayer that finalizes the withdrawal on L1. 0 for self-relay. */
  relayerTip: bigint;
  amount: bigint;
  proverTip: bigint;
  /**
   * One of {@link STABLECOIN_OUTPUT_TOKENS}, only from an executor that pays mainnet DAI. Omit it to get the portal's
   * asset as is, on any chain.
   */
  outputToken?: EthAddress;
  /**
   * Required for USDC and USDT. Omit it for DAI. The least `outputToken`, in its decimals, that `recipient` gets from
   * the amount after the prover tip, the fee, `relayerTip` and `daiForGas`. If the swap gives less, the withdrawal waits
   * for `recover`.
   */
  minOut?: bigint;
  /**
   * DAI to pay as ETH, so that a new `recipient` can pay for gas. Only from an executor that pays mainnet DAI. At most
   * {@link MAX_DAI_FOR_GAS}, 0 if omitted. ETH is not guaranteed: if the swap price is more than 2% under the ETH/USD
   * feed, `recipient` gets this DAI in `outputToken`. If `recipient` rejects ETH, or if the feed price is not valid or
   * not recent, the withdrawal waits for `recover`.
   */
  daiForGas?: bigint;
  /** Signs `recover` if the payout fails. ERC-1271 if it has code, else `personal_sign`. */
  recoveryAccount: EthAddress;
  /**
   * Random if omitted. Use a new salt for each withdrawal. `recover` needs it and nothing on chain shows it, so derive it
   * from the wallet keys or keep it in `recoveryMemo`.
   */
  recoverySalt?: Fr;
  finalizationRequestBroadcastParams?: FinalizationRequestBroadcastParams;
  recoveryMemo?: Buffer;
  authwitNonce?: Fr;
}

export interface StablecoinWithdrawal {
  operation: WithdrawOperation;
  /** Keep it: `recover` needs it. */
  recoverySalt: Fr;
}

/**
 * A withdrawal through the stablecoin withdrawal executor. `recipient` gets the portal's asset as is, or on mainnet USDC or
 * USDT, optionally with ETH for gas. If the payout fails, the withdrawal waits until `recoveryAccount` signs `recover`,
 * which pays the asset to an address that it picks. Throws on input that the executor rejects, or that leaves a swap
 * with no price protection, because nobody could then finalize the withdrawal.
 */
export function buildStablecoinWithdrawal(args: StablecoinWithdrawalArgs): StablecoinWithdrawal {
  const minOut = args.minOut ?? 0n;
  const daiForGas = args.daiForGas ?? 0n;
  assertStablecoinWithdrawalTip(args.amount, args.proverTip, args.relayerTip, args.executor.fee);
  const { outputToken } = args;
  const route =
    outputToken === undefined
      ? StablecoinWithdrawalRoute.DAI
      : STABLECOIN_ROUTES.find(([token]) => token.equals(outputToken))?.[1];
  if (route === undefined) {
    throw new Error(`The stablecoin withdrawal executor pays only DAI, USDC or USDT, not ${outputToken}`);
  }
  if ((outputToken !== undefined || daiForGas > 0n) && !args.executor.asset.equals(MAINNET_DAI)) {
    throw new Error(
      `Only an executor that pays mainnet DAI swaps to an output token or to ETH, not one that pays ${args.executor.asset}`,
    );
  }
  if (route === StablecoinWithdrawalRoute.DAI) {
    if (minOut !== 0n) {
      throw new Error('The executor pays DAI as is and does not read minOut, so a DAI payout takes no minOut');
    }
  } else if (minOut <= 0n) {
    throw new Error('A zero minOut leaves the swap with no price protection');
  }
  if (daiForGas > MAX_DAI_FOR_GAS) {
    throw new Error(`daiForGas ${daiForGas} is above the executor maximum of ${MAX_DAI_FOR_GAS}`);
  }
  const netAmount = stablecoinWithdrawalNetAmount(args.amount, args.proverTip, args.executor.fee);
  if (args.relayerTip + daiForGas > netAmount) {
    throw new Error(
      `Relayer tip ${args.relayerTip} and daiForGas ${daiForGas} exceed the amount after the fee ${netAmount}`,
    );
  }
  if (route !== StablecoinWithdrawalRoute.DAI && args.relayerTip + daiForGas === netAmount) {
    throw new Error(
      `Relayer tip ${args.relayerTip} and daiForGas ${daiForGas} leave no DAI to swap to ${outputToken}, so the swap cannot reach minOut`,
    );
  }
  if (args.recoveryAccount.isZero()) {
    throw new Error('A zero recoveryAccount cannot sign recover, so stuck funds would be lost');
  }
  const recoverySalt = args.recoverySalt ?? Fr.random();
  const userPayload = encodeStablecoinWithdrawalPayload({
    route,
    recipient: args.recipient,
    daiForGas,
    minOut,
    recoveryCommitment: deriveRecoveryCommitment(recoverySalt, args.recoveryAccount).toString() as Hex,
    relayerTip: args.relayerTip,
  });
  const operation: WithdrawOperation = {
    kind: 'withdraw',
    from: args.from,
    executor: args.executor.address,
    userPayload,
    amount: args.amount,
    proverTip: args.proverTip,
    finalizationRequestBroadcastParams: args.finalizationRequestBroadcastParams,
    recoveryMemo: args.recoveryMemo,
    authwitNonce: args.authwitNonce,
  };
  return { operation, recoverySalt };
}
