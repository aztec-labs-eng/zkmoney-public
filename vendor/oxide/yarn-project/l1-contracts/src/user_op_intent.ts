import { type Address, type Hex, type PublicClient, encodeAbiParameters, keccak256 } from 'viem';

import type { PackedUserOperation } from './entrypoint.js';

/** A view call and the expected hash of its result. A zero hash skips the condition. */
export interface UserOpCondition {
  target: Address;
  data: Hex;
  resultHash: Hex;
}

export interface UserOpIntent {
  rollupVersion: bigint;
  /** Checked before and after the user operation. */
  precondition: UserOpCondition;
  postcondition: UserOpCondition;
  /** The L2 note recipient of the deposit. */
  recipientCommitment: Hex;
  // Fields of the userOp.
  owner: Address;
  nonce: bigint;
  callData: Hex;
  accountGasLimits: Hex;
}

export function encodeUserOpIntentData(intent: UserOpIntent): Hex {
  return encodeAbiParameters(INTENT_ABI, [intent]);
}

/** The user operation that the SIPA submits, without its signature; the account signs its EntryPoint hash. */
export function userOpOfIntent(intent: UserOpIntent): PackedUserOperation {
  return {
    sender: intent.owner,
    nonce: intent.nonce,
    initCode: '0x',
    callData: intent.callData,
    accountGasLimits: intent.accountGasLimits,
    preVerificationGas: 0n,
    gasFees: `0x${'00'.repeat(32)}`,
    paymasterAndData: '0x',
    signature: '0x',
  };
}

export function encodeUserOpProofs(signature: Hex): Hex {
  return encodeAbiParameters([{ type: 'bytes' }], [signature]);
}

/** The result hash that the SIPA compares with a condition's: the hash of the raw return data. */
export function conditionHash(returnData: Hex): Hex {
  return keccak256(returnData);
}

/** The result hash of the view call now. */
export async function readConditionHash(publicClient: PublicClient, target: Address, data: Hex) {
  const { data: result } = await publicClient.call({ to: target, data });
  if (!result || result === '0x') {
    const code = await publicClient.getCode({ address: target });
    if (!code || code === '0x') {
      throw new Error(`The condition target ${target} has no code`);
    }
  }
  return conditionHash(result ?? '0x');
}

const CONDITION_ABI = [
  { name: 'target', type: 'address' },
  { name: 'data', type: 'bytes' },
  { name: 'resultHash', type: 'bytes32' },
] as const;

const INTENT_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'rollupVersion', type: 'uint256' },
      { name: 'precondition', type: 'tuple', components: CONDITION_ABI },
      { name: 'postcondition', type: 'tuple', components: CONDITION_ABI },
      { name: 'recipientCommitment', type: 'bytes32' },
      { name: 'owner', type: 'address' },
      { name: 'nonce', type: 'uint64' },
      { name: 'callData', type: 'bytes' },
      { name: 'accountGasLimits', type: 'bytes32' },
    ],
  },
] as const;
