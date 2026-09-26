import { L1OperationCondition, encodeL1OperationCalldata } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, it } from '@jest/globals';
import { type Hex, keccak256, toHex, zeroHash } from 'viem';

import {
  type MetadataUpdateIntent,
  decodeMetadataUpdateIntentData,
  decodeMetadataUpdateProofs,
  decodeUserRecordMetadata,
  encodeMetadataUpdateIntentData,
  encodeMetadataUpdateProofs,
  encodeUserRecordMetadata,
  metadataUpdateDigest,
  oxideAccountPersonalSignDigest,
  userRecordStateHash,
} from './metadata_update.js';
import { buildSipaDeployAndSweepOperation } from './sipa_sweep_operation.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const REGISTRY = '0x2222222222222222222222222222222222222222';
const NAME_REGISTRY = '0x4444444444444444444444444444444444444444';
const SIPA = '0x5555555555555555555555555555555555555555';
const RECORD = {
  l2Address: toHex(11n, { size: 32 }),
  rollupVersion: 7n,
  publicKey: { x: 1n, y: 2n },
  resolverOperator: OWNER,
} as const;
const INTENT: MetadataUpdateIntent = {
  owner: OWNER,
  metadataRegistry: REGISTRY,
  metadata: encodeUserRecordMetadata(RECORD),
  expectedStateHash: zeroHash,
  rollupVersion: 7n,
  namePortal: '0x3333333333333333333333333333333333333333',
  namePortalRecipient: toHex(12n, { size: 32 }),
  recipientCommitment: toHex(13n, { size: 32 }),
};
const digest = (intentData: Hex) =>
  metadataUpdateDigest({ chainId: 31337n, nameRegistry: NAME_REGISTRY, sipa: SIPA, intentData });

function metadataUpdateOperation(signature: Hex) {
  const intentData = encodeMetadataUpdateIntentData(INTENT);
  const proofs = encodeMetadataUpdateProofs(signature);
  return {
    operation: buildSipaDeployAndSweepOperation({
      sipa: SIPA,
      sipaFactory: REGISTRY,
      deployArgs: {
        implementation: OWNER,
        intentHash: keccak256(intentData),
        recoveryCommitment: toHex(1n, { size: 32 }),
        rollupVersion: INTENT.rollupVersion,
        resweepable: false,
      },
      sweepArgs: { token: OWNER, relayer: NAME_REGISTRY, intentData, proofs },
      depositSubsidy: REGISTRY,
      payoutToken: OWNER,
      condition: L1OperationCondition.immediate(),
    }),
    proofs,
  };
}

describe('metadata update', () => {
  // Keep these golden values in sync with l1-contracts/test/periphery/registration/MetadataEncoding.t.sol.
  it('matches the Solidity MetadataEncodingTest vectors', () => {
    const intentData = encodeMetadataUpdateIntentData(INTENT);
    const consent = digest(intentData);
    expect(userRecordStateHash(RECORD)).toBe('0xd428e7e866b6c6cb6cbac2eb76f978e732d0fcfc83586e12f2d8c93ac2cb0b24');
    expect(keccak256(intentData)).toBe('0xe76974e07340706f1fe3e0850e9dad7277d239e86e3c66525b2a025bdc372267');
    expect(consent).toBe('0x516e25812720e14e4f588aad695ecc64ab3ee0e56e892473025853e4c063547f');
    expect(oxideAccountPersonalSignDigest({ chainId: 31337n, account: OWNER, digest: consent })).toBe(
      '0x0e940a7296984481abfae1ca8750cafb4d0448d7fde938bf22906a8b545695b9',
    );
  });
  it('encodes the current destination record independently of the envelope', () => {
    expect(decodeUserRecordMetadata(INTENT.metadata)).toEqual(RECORD);
    expect(userRecordStateHash()).toBe(zeroHash);
    expect(userRecordStateHash(RECORD)).toBe(keccak256(INTENT.metadata));
    expect(decodeMetadataUpdateIntentData(encodeMetadataUpdateIntentData(INTENT))).toEqual(INTENT);
  });

  it.each(['0xab', '0x1234567890'] as Hex[])('transports an incompatible schema without decoding it: %s', metadata => {
    const intent = { ...INTENT, metadata };
    expect(decodeMetadataUpdateIntentData(encodeMetadataUpdateIntentData(intent))).toEqual(intent);
  });

  it('binds every intent field in the consent', () => {
    const baseline = digest(encodeMetadataUpdateIntentData(INTENT));
    const changes: Partial<MetadataUpdateIntent>[] = [
      { owner: SIPA },
      { metadataRegistry: SIPA },
      { metadata: '0xab' },
      { expectedStateHash: toHex(1n, { size: 32 }) },
      { rollupVersion: 8n },
      { namePortal: SIPA },
      { namePortalRecipient: toHex(1n, { size: 32 }) },
      { recipientCommitment: toHex(1n, { size: 32 }) },
    ];
    for (const change of changes) {
      expect(digest(encodeMetadataUpdateIntentData({ ...INTENT, ...change }))).not.toBe(baseline);
    }
    const args = {
      chainId: 31337n,
      nameRegistry: NAME_REGISTRY,
      sipa: SIPA,
      intentData: encodeMetadataUpdateIntentData(INTENT),
    } as const;
    expect(metadataUpdateDigest({ ...args, chainId: 1n })).not.toBe(baseline);
    expect(metadataUpdateDigest({ ...args, sipa: OWNER })).not.toBe(baseline);
    expect(metadataUpdateDigest({ ...args, nameRegistry: OWNER })).not.toBe(baseline);
  });

  it.each([65, 512])('broadcasts an update with a %i-byte account signature in the 2k tier', length => {
    const signature = `0x${'ab'.repeat(length)}` as Hex;
    const { operation, proofs } = metadataUpdateOperation(signature);
    expect(encodeL1OperationCalldata(operation.calldata).tier.method).toBe('broadcast_l1_operation_2k');
    expect(decodeMetadataUpdateProofs(proofs)).toBe(signature);
  });

  it('binds the account signing challenge to the account and chain', () => {
    const consent = digest(encodeMetadataUpdateIntentData(INTENT));
    const args = { chainId: 31337n, account: OWNER, digest: consent } as const;
    const challenge = oxideAccountPersonalSignDigest(args);
    expect(oxideAccountPersonalSignDigest({ ...args, account: SIPA })).not.toBe(challenge);
    expect(oxideAccountPersonalSignDigest({ ...args, chainId: 1n })).not.toBe(challenge);
  });
});
