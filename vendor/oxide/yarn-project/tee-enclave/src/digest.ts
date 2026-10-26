import { Fr } from '@aztec-labs/aztec.js/fields';
import { MAX_L2_TO_L1_MSGS_PER_TX, MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX } from '@aztec-labs/constants';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import { sha256 } from '@aztec-labs/foundation/crypto/sha256';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { BlockHash } from '@aztec-labs/stdlib/block';

import {
  MAX_FROZEN_DEPOSITS_PER_REFUND,
  MAX_FROZEN_NOTES_PER_REFUND,
  TEE_SIG_DOMAIN_FROZEN_DEPOSITS_REFUND,
  TEE_SIG_DOMAIN_FROZEN_NOTES_REFUND,
  TEE_SIG_DOMAIN_NOTE,
  TEE_SIG_DOMAIN_UNPROCESSED_DEPOSIT_REFUND,
  TEE_SIG_DOMAIN_WITHDRAWAL,
  TEE_SIG_DOMAIN_WITHDRAWAL_FINALIZED,
} from '@oxide/oxide-lib-tee/oxide_constants.gen.js';
import { type PortalDomain, TeeSignedData } from '@oxide/oxide-lib-tee/types.js';

type OperationDigestInput = {
  anchorBlockHash: BlockHash;
  tokenAddress: AztecAddress;
  l1Portal: EthAddress;
  teeRegistry: EthAddress;
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
    input.l1Portal,
    input.teeRegistry,
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
   * `TeeRegistry` that the enclave proved the signer's registration against.
   * L1 uses the portal's `TEE_REGISTRY` here, so a digest that names another registry fails.
   */
  teeRegistry: EthAddress;
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
    input.teeRegistry.toBuffer(),
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
// `sha256(domain_byte || publicInputs)` — same domain byte the L1 portal prepends. The
// frozen-notes digest also hashes the `TeeRegistry` right after the domain byte.
// ---------------------------------------------------------------------------

/** Pads `nullifiers` with zeros to `slots` entries. */
function padNullifierSlots(nullifiers: Fr[], slots: number, label: string): Fr[] {
  if (nullifiers.length > slots) {
    throw new Error(`${label} public inputs: ${nullifiers.length} nullifiers exceeds slot count ${slots}`);
  }
  return nullifiers.concat(Array(slots - nullifiers.length).fill(Fr.zero()));
}

export function buildFrozenNotesRefundFinalDigest(input: {
  portalDomain: PortalDomain;
  frozenArchiveRoot: Fr;
  amount: bigint;
  executor: EthAddress;
  userPayloadHash: Fr;
  nullifiers: Fr[];
}): {
  publicInputs: Fr[];
  finalDigest: Buffer32;
} {
  const padded = padNullifierSlots(input.nullifiers, MAX_FROZEN_NOTES_PER_REFUND, 'Frozen-notes');
  const publicInputs = [
    new Fr(input.portalDomain.l1ChainId),
    new Fr(input.portalDomain.rollupVersion),
    input.portalDomain.l1Portal.toField(),
    input.portalDomain.l2Token.toField(),
    input.frozenArchiveRoot,
    new Fr(input.amount),
    input.executor.toField(),
    input.userPayloadHash,
    ...padded,
  ];
  const preimage = Buffer.concat([
    Buffer.of(TEE_SIG_DOMAIN_FROZEN_NOTES_REFUND),
    input.portalDomain.teeRegistry.toBuffer(),
    ...publicInputs.map(pi => pi.toBuffer()),
  ]);
  return { publicInputs, finalDigest: new Buffer32(sha256(preimage)) };
}

export function buildFrozenDepositsRefundFinalDigest(input: {
  portalDomain: PortalDomain;
  frozenArchiveRoot: Fr;
  amount: bigint;
  executor: EthAddress;
  userPayloadHash: Fr;
  nullifiers: Fr[];
}): {
  publicInputs: Fr[];
  finalDigest: Buffer32;
} {
  const padded = padNullifierSlots(input.nullifiers, MAX_FROZEN_DEPOSITS_PER_REFUND, 'Frozen-deposit');
  const publicInputs = [
    new Fr(input.portalDomain.l1ChainId),
    new Fr(input.portalDomain.rollupVersion),
    input.portalDomain.l1Portal.toField(),
    input.frozenArchiveRoot,
    new Fr(input.amount),
    input.executor.toField(),
    input.userPayloadHash,
    ...padded,
  ];
  const preimage = Buffer.concat([
    Buffer.of(TEE_SIG_DOMAIN_FROZEN_DEPOSITS_REFUND),
    ...publicInputs.map(pi => pi.toBuffer()),
  ]);
  return { publicInputs, finalDigest: new Buffer32(sha256(preimage)) };
}

export function buildUnprocessedDepositRefundFinalDigest(input: {
  portalDomain: PortalDomain;
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
    new Fr(input.portalDomain.l1ChainId),
    new Fr(input.portalDomain.rollupVersion),
    input.portalDomain.l1Portal.toField(),
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
