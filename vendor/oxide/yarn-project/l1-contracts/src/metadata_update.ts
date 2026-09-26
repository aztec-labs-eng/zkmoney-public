import {
  type Address,
  type Hex,
  type PublicClient,
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  toHex,
  zeroHash,
} from 'viem';

import type { UserRecordArg } from './account_metadata_registry.js';
import { AccountMetadataControllerAbi } from './artifacts.js';

/** Metadata bytes use the destination controller's schema. The transport does not decode them. */
export interface MetadataUpdateIntent {
  owner: Address;
  metadataRegistry: Address;
  metadata: Hex;
  expectedStateHash: Hex;
  rollupVersion: bigint;
  namePortal: Address;
  namePortalRecipient: Hex;
  recipientCommitment: Hex;
}

const UPDATE_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'owner', type: 'address' },
      { name: 'metadataRegistry', type: 'address' },
      { name: 'metadata', type: 'bytes' },
      { name: 'expectedStateHash', type: 'bytes32' },
      { name: 'rollupVersion', type: 'uint256' },
      { name: 'namePortal', type: 'address' },
      { name: 'namePortalRecipient', type: 'bytes32' },
      { name: 'recipientCommitment', type: 'bytes32' },
    ],
  },
] as const;

const RECORD_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'l2Address', type: 'bytes32' },
      { name: 'rollupVersion', type: 'uint256' },
      {
        name: 'publicKey',
        type: 'tuple',
        components: [
          { name: 'x', type: 'uint256' },
          { name: 'y', type: 'uint256' },
        ],
      },
      { name: 'resolverOperator', type: 'address' },
    ],
  },
] as const;

export function encodeMetadataUpdateIntentData(intent: MetadataUpdateIntent): Hex {
  return encodeAbiParameters(UPDATE_ABI, [intent]);
}

export function decodeMetadataUpdateIntentData(data: Hex): MetadataUpdateIntent {
  return decodeAbiParameters(UPDATE_ABI, data)[0];
}

/** Encode only the current UserRecord schema. A future controller supplies its own codec. */
export function encodeUserRecordMetadata(record: UserRecordArg): Hex {
  return encodeAbiParameters(RECORD_ABI, [record]);
}

export function decodeUserRecordMetadata(metadata: Hex): UserRecordArg {
  return decodeAbiParameters(RECORD_ABI, metadata)[0];
}

/** The current schema's expected-state commitment. An absent record uses zero. */
export function userRecordStateHash(record?: UserRecordArg): Hex {
  return record === undefined ? zeroHash : keccak256(encodeUserRecordMetadata(record));
}

export function encodeMetadataUpdateProofs(accountSignature: Hex): Hex {
  return encodeAbiParameters([{ type: 'bytes' }], [accountSignature]);
}

export function decodeMetadataUpdateProofs(proofs: Hex): Hex {
  return decodeAbiParameters([{ type: 'bytes' }], proofs)[0];
}

/** Digest passed to ERC-1271. The complete intent binds the destination registry and routing. */
export function metadataUpdateDigest(args: {
  chainId: bigint;
  nameRegistry: Address;
  sipa: Address;
  intentData: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [
        keccak256(toHex('Oxide Metadata Update v1')),
        args.chainId,
        args.nameRegistry,
        args.sipa,
        keccak256(args.intentData),
      ],
    ),
  );
}

/** Sign this digest directly with the active bootstrap key or as the WebAuthn challenge. */
export function oxideAccountPersonalSignDigest(args: { chainId: bigint; account: Address; digest: Hex }): Hex {
  const domain = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [
        keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
        keccak256(toHex('OxideAccount')),
        keccak256(toHex('1')),
        args.chainId,
        args.account,
      ],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [keccak256(toHex('PersonalSign(bytes prefixed)')), args.digest],
    ),
  );
  return keccak256(concatHex(['0x1901', domain, structHash]));
}

/** Read through the destination decoder; callers must also bind the live metadata-registry pointer. */
export async function readMetadataStateHash(
  publicClient: PublicClient,
  controller: Address,
  owner: Address,
): Promise<Hex> {
  return await publicClient.readContract({
    address: controller,
    abi: AccountMetadataControllerAbi,
    functionName: 'metadataStateHash',
    args: [owner],
  });
}
