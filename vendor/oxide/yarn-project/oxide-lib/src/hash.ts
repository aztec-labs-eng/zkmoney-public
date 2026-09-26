import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr, GrumpkinScalar } from '@aztec/aztec.js/fields';
import { DomainSeparator } from '@aztec/constants';
import { poseidon2Hash, poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import {
  computeL2ToL1MessageHash,
  computePublicDataTreeLeafSlot,
  deriveStorageSlotInMap,
  siloNoteHash,
  siloNullifier,
} from '@aztec/stdlib/hash';
import { computeAppNullifierHidingKey } from '@aztec/stdlib/keys';

import { getWithdrawContentHash } from './content_hash.js';
import { APPROVED_SIGNERS_STORAGE_SLOT, BALANCES_STORAGE_SLOT } from './oxide_constants.gen.js';
import { type OutboxWithdrawal, type PortalContext, type SecpPublicKey, splitSecpCoord } from './types.js';

export function computeWithdrawMessageHash(portal: PortalContext, withdrawal: OutboxWithdrawal): Fr {
  return computeL2ToL1MessageHash({
    l2Sender: portal.l2Portal,
    l1Recipient: portal.l1Portal,
    content: getWithdrawContentHash(
      withdrawal.executor,
      withdrawal.userPayloadHash,
      withdrawal.amount,
      withdrawal.proverTip,
      withdrawal.randomness,
    ),
    rollupVersion: new Fr(portal.rollupVersion),
    chainId: new Fr(portal.l1ChainId),
  });
}

export async function computeSiloedNoteHash(args: {
  amount: bigint;
  owner: AztecAddress;
  randomness: Fr;
  l2Portal: AztecAddress;
}) {
  const innerNoteHash = await poseidon2HashWithSeparator(
    [new Fr(args.amount), args.owner, BALANCES_STORAGE_SLOT, args.randomness],
    DomainSeparator.NOTE_HASH,
  );
  return siloNoteHash(args.l2Portal, innerNoteHash);
}

export async function computeNoteNullifier(
  provenNoteHash: Fr,
  contractAddress: AztecAddress,
  masterNullifierHidingKey: GrumpkinScalar,
): Promise<Fr> {
  const appNullifierHidingKey = await computeAppNullifierHidingKey(masterNullifierHidingKey, contractAddress);
  const innerNullifier = await poseidon2HashWithSeparator(
    [provenNoteHash, appNullifierHidingKey],
    DomainSeparator.NOTE_NULLIFIER,
  );
  return await siloNullifier(contractAddress, innerNullifier);
}

/** The `approved_signers` map slot for `publicKey`, keyed by `poseidon2_hash([x_hi, x_lo, y_hi, y_lo])`. */
export async function computeSignerApprovalStorageSlot(publicKey: SecpPublicKey): Promise<Fr> {
  const x = splitSecpCoord(publicKey.x);
  const y = splitSecpCoord(publicKey.y);
  const signerKey = await poseidon2Hash([x.hi, x.lo, y.hi, y.lo]);
  return await deriveStorageSlotInMap(new Fr(APPROVED_SIGNERS_STORAGE_SLOT), signerKey);
}

export async function computeSignerApprovalLeafSlot(tokenAddress: AztecAddress, publicKey: SecpPublicKey) {
  return await computePublicDataTreeLeafSlot(tokenAddress, await computeSignerApprovalStorageSlot(publicKey));
}
