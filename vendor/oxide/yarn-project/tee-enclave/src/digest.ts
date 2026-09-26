import { Fr } from '@aztec/aztec.js/fields';
import { MAX_L2_TO_L1_MSGS_PER_TX, MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX } from '@aztec/constants';
import { Buffer32 } from '@aztec/foundation/buffer';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { sha256 } from '@aztec/foundation/crypto/sha256';
import type { EthAddress } from '@aztec/foundation/eth-address';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { BlockHash } from '@aztec/stdlib/block';

import {
  MAX_FROZEN_NOTES_PER_REFUND,
  TEE_SIG_DOMAIN_FROZEN_DEPOSIT_REFUND,
  TEE_SIG_DOMAIN_FROZEN_NOTES_REFUND,
  TEE_SIG_DOMAIN_NOTE,
  TEE_SIG_DOMAIN_UNPROCESSED_DEPOSIT_REFUND,
  TEE_SIG_DOMAIN_WITHDRAWAL,
  TEE_SIG_DOMAIN_WITHDRAWAL_FINALIZED,
} from '@oxide/oxide-lib/oxide_constants.gen.js';
import { type PortalContext, TeeSignedData } from '@oxide/oxide-lib/types.js';

type OperationDigestInput = {
  anchorBlockHash: BlockHash;
  tokenAddress: AztecAddress;
  requiredNullifiers: Fr[];
  siloedNoteHashes: Fr[];
  withdrawalMessageHashes: Fr[];
};

async function buildOperationDigest(
  domain: number,
  input: OperationDigestInput & { signedCommitment: Fr },
): Promise<Fr> {
  if (input.requiredNullifiers.length > MAX_NULLIFIERS_PER_TX) {
    throw new Error(
      `Too many required nullifiers: got ${input.requiredNullifiers.length}, max ${MAX_NULLIFIERS_PER_TX}`,
    );
  }
  if (input.siloedNoteHashes.length > MAX_NOTE_HASHES_PER_TX) {
    throw new Error(`Too many siloed note hashes: got ${input.siloedNoteHashes.length}, max ${MAX_NOTE_HASHES_PER_TX}`);
  }
  if (input.withdrawalMessageHashes.length > MAX_L2_TO_L1_MSGS_PER_TX) {
    throw new Error(
      `Too many withdrawal message hashes: got ${input.withdrawalMessageHashes.length}, max ${MAX_L2_TO_L1_MSGS_PER_TX}`,
    );
  }
  const data = new TeeSignedData(
    domain,
    input.anchorBlockHash,
    input.tokenAddress,
    input.signedCommitment,
    input.requiredNullifiers,
    input.siloedNoteHashes,
    input.withdrawalMessageHashes,
  );
  return await poseidon2Hash(data.toFields());
}

export function buildNoteOperationDigest(
  input: OperationDigestInput & {
    siloedNoteHash: Fr;
  },
): Promise<Fr> {
  return buildOperationDigest(TEE_SIG_DOMAIN_NOTE, { ...input, signedCommitment: input.siloedNoteHash });
}

export function buildWithdrawalOperationDigest(
  input: OperationDigestInput & {
    messageHash: Fr;
  },
): Promise<Fr> {
  return buildOperationDigest(TEE_SIG_DOMAIN_WITHDRAWAL, { ...input, signedCommitment: input.messageHash });
}

export function buildWithdrawalFinalDigest(input: {
  /**
   * Archive root that contains the first-phase operation anchor block hash.
   * L1 derives this from `Rollup.archiveAt(checkpointNumber)`.
   */
  archiveRoot: Fr;
  /**
   * Per-withdrawal id, computed as `sha256(creation_tx_hash || message_hash)`. L1 stores it in
   * `$isWithdrawalSpent` to prevent replay of the same withdrawal and otherwise treats it as opaque.
   */
  withdrawalId: Buffer32;
  /** Outbox leaf hash for this withdrawal. L1 rebuilds this from the withdraw params. */
  messageHash: Fr;
}): Buffer32 {
  const preimage = Buffer.concat([
    Buffer.of(TEE_SIG_DOMAIN_WITHDRAWAL_FINALIZED),
    input.archiveRoot.toBuffer(),
    input.withdrawalId.toBuffer(),
    input.messageHash.toBuffer(),
  ]);
  return new Buffer32(sha256(preimage));
}

// ---------------------------------------------------------------------------
// Refund digest builders.
//
// The public-input arrays below are baked-in three places that must agree byte-for-byte: this
// builder, the `OxidePortal.withdraw{FrozenNotes,FrozenDeposit}` Solidity code that rebuilds
// publicInputs at finalization, and the Noir circuit's `pub` parameter ordering. The digest is
// `sha256(domain_byte || publicInputs)` — same domain byte the L1 portal prepends.
// ---------------------------------------------------------------------------

export function buildFrozenNotesRefundFinalDigest(input: {
  portal: PortalContext;
  frozenArchiveRoot: Fr;
  amount: bigint;
  executor: EthAddress;
  userPayloadHash: Fr;
  nullifiers: Fr[];
}): {
  publicInputs: Fr[];
  finalDigest: Buffer32;
} {
  if (input.nullifiers.length > MAX_FROZEN_NOTES_PER_REFUND) {
    throw new Error(
      `Frozen-notes public inputs: ${input.nullifiers.length} nullifiers exceeds slot count ${MAX_FROZEN_NOTES_PER_REFUND}`,
    );
  }
  const padded = input.nullifiers.concat(Array(MAX_FROZEN_NOTES_PER_REFUND - input.nullifiers.length).fill(Fr.zero()));
  const publicInputs = [
    new Fr(input.portal.l1ChainId),
    new Fr(input.portal.rollupVersion),
    input.portal.l1Portal.toField(),
    input.portal.l2Portal.toField(),
    input.frozenArchiveRoot,
    new Fr(input.amount),
    input.executor.toField(),
    input.userPayloadHash,
    ...padded,
  ];
  const preimage = Buffer.concat([
    Buffer.of(TEE_SIG_DOMAIN_FROZEN_NOTES_REFUND),
    ...publicInputs.map(pi => pi.toBuffer()),
  ]);
  return { publicInputs, finalDigest: new Buffer32(sha256(preimage)) };
}

export function buildFrozenDepositRefundFinalDigest(input: {
  portal: PortalContext;
  frozenArchiveRoot: Fr;
  amount: bigint;
  executor: EthAddress;
  userPayloadHash: Fr;
  siloedNullifier: Fr;
}): {
  publicInputs: Fr[];
  finalDigest: Buffer32;
} {
  const publicInputs = [
    new Fr(input.portal.l1ChainId),
    new Fr(input.portal.rollupVersion),
    input.portal.l1Portal.toField(),
    input.frozenArchiveRoot,
    new Fr(input.amount),
    input.executor.toField(),
    input.userPayloadHash,
    input.siloedNullifier,
  ];
  const preimage = Buffer.concat([
    Buffer.of(TEE_SIG_DOMAIN_FROZEN_DEPOSIT_REFUND),
    ...publicInputs.map(pi => pi.toBuffer()),
  ]);
  return { publicInputs, finalDigest: new Buffer32(sha256(preimage)) };
}

export function buildUnprocessedDepositRefundFinalDigest(input: {
  portal: PortalContext;
  frozenArchiveRoot: Fr;
  amount: bigint;
  executor: EthAddress;
  userPayloadHash: Fr;
  messageHash: Fr;
  messageLeafIndex: Fr;
  siloedNullifier: Fr;
}): {
  publicInputs: Fr[];
  finalDigest: Buffer32;
} {
  const publicInputs = [
    new Fr(input.portal.l1ChainId),
    new Fr(input.portal.rollupVersion),
    input.portal.l1Portal.toField(),
    input.frozenArchiveRoot,
    new Fr(input.amount),
    input.executor.toField(),
    input.userPayloadHash,
    input.messageHash,
    input.messageLeafIndex,
    input.siloedNullifier,
  ];
  const preimage = Buffer.concat([
    Buffer.of(TEE_SIG_DOMAIN_UNPROCESSED_DEPOSIT_REFUND),
    ...publicInputs.map(pi => pi.toBuffer()),
  ]);
  return { publicInputs, finalDigest: new Buffer32(sha256(preimage)) };
}
