import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { type Hex, encodePacked, zeroHash } from 'viem';

import {
  type ExecutorCall,
  assertPayloadLength,
  encodeExecutorRelayerPayload,
  withdrawalExecutionAmount,
} from './executor.js';

const USER_PAYLOAD_TYPES = ['uint8', 'address', 'uint128', 'uint128', 'bytes32', 'uint128'] as const;
const USER_PAYLOAD_BYTES = 101;
const RECOVERY_COMMITMENT_BITS = 248n;

/** The output token of a stablecoin withdrawal, numbered as the executor's routes. */
export enum StablecoinWithdrawalRoute {
  USDC = 0,
  USDT = 1,
  /** The portal's asset as is, on every chain. */
  DAI = 2,
}

/** The payload of a stablecoin withdrawal. With a memo of up to 57 bytes, it fits in one recovery chunk. */
export interface StablecoinWithdrawalPayload {
  route: StablecoinWithdrawalRoute;
  recipient: EthAddress;
  /** DAI to pay as ETH. 0 for no ETH. */
  daiForGas: bigint;
  /** The least output token, in its decimals, that `recipient` gets. Not read for the DAI route. */
  minOut: bigint;
  /** Opens to the account that signs `recover`. */
  recoveryCommitment: Hex;
  relayerTip: bigint;
}

/** Throws on a recovery commitment that `recover` could never open. */
export function encodeStablecoinWithdrawalPayload(payload: StablecoinWithdrawalPayload): Buffer {
  const commitment = BigInt(payload.recoveryCommitment);
  if (commitment === 0n || commitment >> RECOVERY_COMMITMENT_BITS !== 0n) {
    throw new Error('Stablecoin withdrawal recoveryCommitment must be nonzero and fit 248 bits.');
  }
  return encodeUserPayload(payload);
}

export function decodeStablecoinWithdrawalPayload(payload: Buffer): StablecoinWithdrawalPayload {
  assertPayloadLength(payload, USER_PAYLOAD_BYTES, 'Stablecoin withdrawal user');
  const uint = (start: number, end: number) => BigInt(`0x${payload.subarray(start, end).toString('hex')}`);
  const recipient = EthAddress.fromBuffer(Buffer.from(payload.subarray(1, 21)));
  assertStablecoinWithdrawalRecipient(recipient);
  return {
    route: payload[0] as StablecoinWithdrawalRoute,
    recipient,
    daiForGas: uint(21, 37),
    minOut: uint(37, 53),
    recoveryCommitment: `0x${payload.subarray(53, 85).toString('hex')}`,
    relayerTip: uint(85, 101),
  };
}

function encodeUserPayload(payload: StablecoinWithdrawalPayload): Buffer {
  assertStablecoinWithdrawalRecipient(payload.recipient);
  return Buffer.from(
    encodePacked(USER_PAYLOAD_TYPES, [
      payload.route,
      payload.recipient.toString() as Hex,
      payload.daiForGas,
      payload.minOut,
      payload.recoveryCommitment,
      payload.relayerTip,
    ]).slice(2),
    'hex',
  );
}

export function assertStablecoinWithdrawalTip(
  amount: bigint,
  proverTip: bigint,
  relayerTip: bigint,
  withdrawalFee: bigint,
): void {
  const netAmount = stablecoinWithdrawalNetAmount(amount, proverTip, withdrawalFee);
  if (relayerTip > netAmount) {
    throw new Error(`Stablecoin withdrawal relayer tip ${relayerTip} exceeds the amount after the fee ${netAmount}.`);
  }
}

/** The tokens left after the withdrawal fee. Throws if none are left, because the executor then reverts. */
export function stablecoinWithdrawalNetAmount(amount: bigint, proverTip: bigint, withdrawalFee: bigint): bigint {
  const executorAmount = withdrawalExecutionAmount(amount, proverTip);
  if (executorAmount <= withdrawalFee) {
    throw new Error(
      `Stablecoin withdrawal amount after the prover tip ${executorAmount} is not above the fee ${withdrawalFee}.`,
    );
  }
  return executorAmount - withdrawalFee;
}

function assertStablecoinWithdrawalRecipient(recipient: EthAddress): void {
  if (recipient.equals(EthAddress.ZERO)) {
    throw new Error('Stablecoin withdrawal recipient must not be zero.');
  }
}

/**
 * Build the executor call that routes a refund through the canonical stablecoin withdrawal executor: the
 * executor pays `relayerTip` to the relayer-named `tipRecipient` and the remainder to `recipient`.
 * The payload commits to no recovery account, because `recover` cannot reach a refund.
 */
export function buildStablecoinExecutorCall(args: {
  executor: EthAddress;
  recipient: EthAddress;
  relayerTip?: bigint;
  tipRecipient?: EthAddress;
}): ExecutorCall {
  const relayerTip = args.relayerTip ?? 0n;
  const userPayload = encodeUserPayload({
    route: StablecoinWithdrawalRoute.DAI,
    recipient: args.recipient,
    daiForGas: 0n,
    minOut: 0n,
    recoveryCommitment: zeroHash,
    relayerTip,
  });
  const relayerPayload = encodeExecutorRelayerPayload({ tipRecipient: args.tipRecipient ?? EthAddress.ZERO });
  return { executor: args.executor, userPayload, relayerPayload };
}
