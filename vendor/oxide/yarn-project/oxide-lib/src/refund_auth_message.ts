/**
 * Refund authorization messages shared by the refund circuits' hint builders and the TEE. The account owner authorizes
 * one message per refund proof, with the account's passkey or with its master fallback key (see
 * `refund_authorization.ts`).
 *
 * This module mirrors the `compute_*_refund_auth_message` functions of the three refund circuits in
 * `noir-projects`.
 */
import { padArrayEnd } from '@aztec/foundation/collection';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { EthAddress } from '@aztec/foundation/eth-address';

import {
  DOM_SEP__FROZEN_DEPOSIT_AUTH,
  DOM_SEP__FROZEN_NOTES_AUTH,
  DOM_SEP__UNPROCESSED_DEPOSIT_AUTH,
  MAX_FROZEN_NOTES_PER_REFUND,
} from './oxide_constants.gen.js';

export function computeUnprocessedDepositRefundAuthMessage(
  messageHash: Fr,
  executor: EthAddress,
  userPayloadHash: Fr,
): Promise<Fr> {
  return poseidon2HashWithSeparator(
    [messageHash, executor.toField(), userPayloadHash],
    DOM_SEP__UNPROCESSED_DEPOSIT_AUTH,
  );
}

export async function computeFrozenNotesRefundAuthMessage(
  uniqueNoteHashes: Fr[],
  executor: EthAddress,
  userPayloadHash: Fr,
): Promise<Fr> {
  const padded = padArrayEnd(
    uniqueNoteHashes,
    Fr.ZERO,
    MAX_FROZEN_NOTES_PER_REFUND,
    `Frozen-notes refund authorizes ${uniqueNoteHashes.length} notes, max ${MAX_FROZEN_NOTES_PER_REFUND}`,
  );
  return await poseidon2HashWithSeparator([executor.toField(), userPayloadHash, ...padded], DOM_SEP__FROZEN_NOTES_AUTH);
}

export function computeFrozenDepositRefundAuthMessage(
  messageHash: Fr,
  executor: EthAddress,
  userPayloadHash: Fr,
): Promise<Fr> {
  return poseidon2HashWithSeparator([messageHash, executor.toField(), userPayloadHash], DOM_SEP__FROZEN_DEPOSIT_AUTH);
}
