import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { MAX_L2_TO_L1_MSGS_PER_TX, MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX } from '@aztec/constants';
import { padArrayEnd } from '@aztec/foundation/collection';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { sha256ToField } from '@aztec/foundation/crypto/sha256';
import type { EthAddress } from '@aztec/foundation/eth-address';
import { Capsule } from '@aztec/stdlib/tx';

import { getUserPayloadHash, getWithdrawContentHash } from '@oxide/oxide-lib/content_hash.js';
import { decodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal.js';
import { K1NoteSignature, OutboxWithdrawal, TEEMetadata } from '@oxide/oxide-lib/types.js';

const SEED_CAPSULE_SLOT = sha256ToField([Buffer.from('OXIDE_TOKEN::RANDOMNESS_SEED')]);
const NOTE_SIGNATURE_CAPSULE_SLOT = sha256ToField([Buffer.from('OXIDE_TOKEN::NOTE_SIGNATURE')]);
const WITHDRAWAL_SIGNATURE_CAPSULE_SLOT = sha256ToField([Buffer.from('OXIDE_TOKEN::WITHDRAWAL_SIGNATURE')]);
const STRICT_MODE_CAPSULE_SLOT = sha256ToField([Buffer.from('OXIDE_TOKEN::STRICT_MODE_CAPSULE_SLOT')]);
const TEE_NOTES_DA_CAPSULE_KEY = sha256ToField([Buffer.from('oxideTeeNotesCapsuleKey')]);
const TEE_REQUIRED_NULLIFIERS_DA_CAPSULE_KEY = sha256ToField([Buffer.from('oxideTeeRequiredNullifiersCapsuleKey')]);
const TEE_METADATA_DA_CAPSULE_KEY = sha256ToField([Buffer.from('oxideTeeMetadataCapsuleKey')]);
const TEE_WITHDRAWAL_MESSAGE_HASHES_DA_CAPSULE_KEY = sha256ToField([
  Buffer.from('oxideTeeWithdrawalMessageHashesCapsuleKey'),
]);

export function buildSeedCapsule(contractAddress: AztecAddress): Capsule {
  return new Capsule(contractAddress, SEED_CAPSULE_SLOT, [Fr.random()]);
}

export async function buildNoteSignatureCapsule(
  contractAddress: AztecAddress,
  noteRandomness: Fr,
  signature: K1NoteSignature,
): Promise<Capsule> {
  const slot = await poseidon2Hash([NOTE_SIGNATURE_CAPSULE_SLOT, noteRandomness]);
  return new Capsule(contractAddress, slot, [signature.sLo, signature.sHi, signature.rLo, signature.rHi]);
}

export async function buildWithdrawalSignatureCapsule(
  contractAddress: AztecAddress,
  withdrawal: OutboxWithdrawal,
  signature: K1NoteSignature,
): Promise<Capsule> {
  const contentHash = getWithdrawContentHash(
    withdrawal.executor,
    withdrawal.userPayloadHash,
    withdrawal.amount,
    withdrawal.proverTip,
    withdrawal.randomness,
  );
  const slot = await poseidon2Hash([WITHDRAWAL_SIGNATURE_CAPSULE_SLOT, contentHash]);
  return new Capsule(contractAddress, slot, [signature.sLo, signature.sHi, signature.rLo, signature.rHi]);
}

// -------------------------------------------------------------------------------------------
// TEMPORARY: plain-executor user payload recovery.
//
// Remove this block with:
// https://linear.app/aztec-labs/issue/OX-1700/solve-user-payload-data-availability
// -------------------------------------------------------------------------------------------

const PLAIN_EXECUTOR_USER_PAYLOAD_CAPSULE_SLOT = sha256ToField([
  Buffer.from('OXIDE_TOKEN::PLAIN_EXECUTOR_USER_PAYLOAD'),
]);

export async function buildPlainExecutorUserPayloadCapsule(
  contractAddress: AztecAddress,
  withdrawal: OutboxWithdrawal,
  recipient: Fr,
  relayerTip: bigint,
): Promise<Capsule> {
  const contentHash = getWithdrawContentHash(
    withdrawal.executor,
    withdrawal.userPayloadHash,
    withdrawal.amount,
    withdrawal.proverTip,
    withdrawal.randomness,
  );
  const slot = await poseidon2Hash([PLAIN_EXECUTOR_USER_PAYLOAD_CAPSULE_SLOT, contentHash]);
  return new Capsule(contractAddress, slot, [recipient, new Fr(relayerTip)]);
}

/**
 * Build the user payload capsule of each plain-executor withdrawal in a tx. Each withdrawal gets the payload whose
 * hash it commits to, so the order of `userPayloads` is not important. Withdrawals through other executors get no
 * capsule.
 *
 * @param withdrawals - The withdrawals of the token operation, in contract-walk order.
 * @param userPayloads - The user payloads of the withdrawals in the tx.
 */
export async function buildPlainExecutorUserPayloadCapsules(
  contractAddress: AztecAddress,
  withdrawals: OutboxWithdrawal[],
  userPayloads: Buffer[],
  plainWithdrawalExecutor: EthAddress | undefined,
): Promise<Capsule[]> {
  if (!plainWithdrawalExecutor) {
    return [];
  }
  const payloadsByHash = new Map(userPayloads.map(payload => [getUserPayloadHash(payload).toString(), payload]));
  return await Promise.all(
    withdrawals
      .filter(withdrawal => withdrawal.executor.equals(plainWithdrawalExecutor))
      .map(withdrawal => {
        const payload = payloadsByHash.get(withdrawal.userPayloadHash.toString());
        if (!payload) {
          throw new Error(`No user payload has the user payload hash ${withdrawal.userPayloadHash} of a withdrawal.`);
        }
        const { recipient, relayerTip } = decodePlainWithdrawalPayload(payload);
        return buildPlainExecutorUserPayloadCapsule(contractAddress, withdrawal, recipient.toField(), relayerTip);
      }),
  );
}

// ----------------------------------- end TEMPORARY -----------------------------------------

/**
 * Strict-mode capsule: when present, the contract aborts if a per-note signature
 * capsule is missing instead of silently substituting zeros. Attach this on tx
 * submission so a misconfigured TEE flow fails loudly; omit it on the pre-submit
 * simulate that we use to collect offchain effects (signatures aren't known yet).
 */
export function buildStrictModeCapsule(contractAddress: AztecAddress): Capsule {
  return new Capsule(contractAddress, STRICT_MODE_CAPSULE_SLOT, [Fr.ONE]);
}

export function buildTeeNotesCapsule(contractAddress: AztecAddress, teeNotes: Fr[]): Capsule {
  return new Capsule(contractAddress, TEE_NOTES_DA_CAPSULE_KEY, [
    ...padArrayEnd(teeNotes, Fr.zero(), MAX_NOTE_HASHES_PER_TX),
    new Fr(teeNotes.length),
  ]);
}

export function buildTeeRequiredNullifiersCapsule(contractAddress: AztecAddress, requiredNullifiers: Fr[]): Capsule {
  return new Capsule(contractAddress, TEE_REQUIRED_NULLIFIERS_DA_CAPSULE_KEY, [
    ...padArrayEnd(requiredNullifiers, Fr.zero(), MAX_NULLIFIERS_PER_TX),
    new Fr(requiredNullifiers.length),
  ]);
}

export function buildTeeMetadataCapsule(contractAddress: AztecAddress, metadata: TEEMetadata): Capsule {
  return new Capsule(contractAddress, TEE_METADATA_DA_CAPSULE_KEY, metadata.toFields());
}

export function buildTeeWithdrawalMessageHashesCapsule(
  contractAddress: AztecAddress,
  withdrawalMessageHashes: Fr[],
): Capsule {
  return new Capsule(contractAddress, TEE_WITHDRAWAL_MESSAGE_HASHES_DA_CAPSULE_KEY, [
    ...padArrayEnd(withdrawalMessageHashes, Fr.zero(), MAX_L2_TO_L1_MSGS_PER_TX),
    new Fr(withdrawalMessageHashes.length),
  ]);
}
