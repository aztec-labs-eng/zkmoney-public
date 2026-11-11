import { type Address, type Hex, encodeAbiParameters } from 'viem';

import type { R1PublicKeyArg } from './account.js';
import { RECORD_ABI, type UserRecordArg } from './account_metadata_registry.js';

/**
 * Mirrors `AddPasskeyIntent`: one user operation of `owner` that adds `key`, writes `record` and notifies the
 * NamePortal.
 */
export type AddPasskeyIntent = {
  rollupVersion: bigint;
  /** The L2 note recipient of the deposit. */
  recipientCommitment: Hex;
  owner: Address;
  nonce: bigint;
  accountGasLimits: Hex;
  record: UserRecordArg;
  namePortalRecipient: Hex;
  key: R1PublicKeyArg;
  metadata: Hex;
};

export function encodeAddPasskeyIntentData(intent: AddPasskeyIntent): Hex {
  return encodeAbiParameters(INTENT_ABI, [intent]);
}

/** The sweep proofs: the account's signature of the user operation hash. */
export function encodeAddPasskeyProofs(signature: Hex): Hex {
  return encodeAbiParameters([{ type: 'bytes' }], [signature]);
}

const INTENT_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'rollupVersion', type: 'uint256' },
      { name: 'recipientCommitment', type: 'bytes32' },
      { name: 'owner', type: 'address' },
      { name: 'nonce', type: 'uint64' },
      { name: 'accountGasLimits', type: 'bytes32' },
      { name: 'record', type: 'tuple', components: RECORD_ABI[0].components },
      { name: 'namePortalRecipient', type: 'bytes32' },
      {
        name: 'key',
        type: 'tuple',
        components: [
          { name: 'qx', type: 'bytes32' },
          { name: 'qy', type: 'bytes32' },
        ],
      },
      { name: 'metadata', type: 'bytes' },
    ],
  },
] as const;
