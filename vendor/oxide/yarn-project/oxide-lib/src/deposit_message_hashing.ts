// TS mirror of the deposit message derivation in `oxide_token_lib/src/deposit_message_hashing.nr`, shared by the
// enclave signer and the oxide-client deposit/refund flows. Drift from the Noir side is a signature-verification or
// nullifier-replay bug, so there is exactly one source of truth per language.
import { keccak256 } from '@aztec/foundation/crypto/keccak';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { sha256ToField } from '@aztec/foundation/crypto/sha256';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import { siloNullifier } from '@aztec/stdlib/hash';
import { computeAppNullifierHidingKey } from '@aztec/stdlib/keys';
import { L1Actor, L1ToL2Message, L2Actor } from '@aztec/stdlib/messaging';

import { DOM_SEP__DEPOSIT_MESSAGE_NULLIFIER } from './oxide_constants.gen.js';
import { computeRecipientCommitment } from './recipient_commitment.js';
import type { PortalContext } from './types.js';

/** Caller-supplied preimage of an L1->L2 deposit message: the `recipientCommitment` preimage the depositor passed
 *  to `OxidePortal.deposit`, the amount, and the inbox leaf index. */
export interface DepositMessagePreimage {
  sharedSecretSalt: Fr;
  recipient: AztecAddress;
  amount: bigint;
  messageLeafIndex: Fr;
}

/** L1 -> L2 deposit message content hash. Must match `OxidePortal.sol::deposit` byte-for-byte. The recipient
 *  commitment is not part of the content; it sits in the message's secretHash slot. */
export function getDepositMessageContentHash(amount: bigint): Fr {
  const selector = keccak256(Buffer.from('deposit(uint256)')).subarray(0, 4);
  const bytes = Buffer.concat([selector, new Fr(amount).toBuffer()]);
  return sha256ToField([bytes]);
}

/**
 * Recompute the L1->L2 deposit message hash this portal would have inserted into the inbox when the depositor
 * called `OxidePortal.deposit(recipientCommitment, amount)`. Used by the deposit-spend and deposit-refund flows to
 * pin a proof / signature to the exact deposit they refer to.
 */
export async function computeDepositMessageHash(portal: PortalContext, preimage: DepositMessagePreimage): Promise<Fr> {
  const recipientCommitment = await computeRecipientCommitment(preimage.sharedSecretSalt, preimage.recipient);
  const message = new L1ToL2Message(
    new L1Actor(portal.l1Portal, Number(portal.l1ChainId)),
    new L2Actor(portal.l2Portal, Number(portal.rollupVersion)),
    getDepositMessageContentHash(preimage.amount),
    recipientCommitment,
    preimage.messageLeafIndex,
  );
  return message.hash();
}

/**
 * Recompute the siloed nullifier the token contract would emit if it ever consumed the deposit's L1->L2 message.
 * The L2 nullifier-tree value the frozen-deposit-refund circuit's non-membership check is taken against, and the
 * value the deposit-spend flow folds into `requiredNullifiers` so the operation's signature is bound to the exact
 * deposit consumed. Keyed on the recipient's app-siloed nullifier hiding key; the caller must have validated that
 * `masterNullifierHidingKey` belongs to the recipient committed in the message.
 */
export async function computeSiloedDepositMessageNullifier(
  l2Portal: AztecAddress,
  messageHash: Fr,
  masterNullifierHidingKey: GrumpkinScalar,
): Promise<Fr> {
  // Mirrors `oxide_token_lib::deposit_message_hashing::compute_deposit_message_nullifier`, siloed to the token
  // contract like the kernel does.
  const appNullifierHidingKey = await computeAppNullifierHidingKey(masterNullifierHidingKey, l2Portal);
  const innerNullifier = await poseidon2HashWithSeparator(
    [messageHash, appNullifierHidingKey],
    DOM_SEP__DEPOSIT_MESSAGE_NULLIFIER,
  );
  return await siloNullifier(l2Portal, innerNullifier);
}
