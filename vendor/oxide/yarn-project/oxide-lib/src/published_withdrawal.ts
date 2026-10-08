import { Buffer32 } from '@aztec/foundation/buffer';
import { sha256 } from '@aztec/foundation/crypto/sha256';
import { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';
import { FieldReader } from '@aztec/foundation/serialize';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import { computeL2ToL1MessageHash } from '@aztec/stdlib/hash';
import { SiloedTag, Tag } from '@aztec/stdlib/logs';
import type { TxHash } from '@aztec/stdlib/tx';

import { getWithdrawContentHash } from './content_hash.js';
import { WITHDRAWAL_PUBLISHING_TAG } from './oxide_constants.gen.js';
import type { K1NoteSignature } from './types.js';

/** Index of the siloed tag in a `withdrawalPublishing` private log; the payload follows it. */
export const WITHDRAWAL_LOG_TAG_INDEX = 0;

/** The per-withdrawal data `publish_withdrawal` emits on L2, laid out as `withdrawal.nr` serializes it. */
export interface PublishedWithdrawal {
  executor: EthAddress;
  userPayloadHash: Fr;
  amount: bigint;
  proverTip: bigint;
  randomness: Fr;
  recipient: EthAddress;
  relayerTip: bigint;
  signature: K1NoteSignature;
}

/** The tag every `withdrawalPublishing` log of `l2Token` carries in its first field. */
export async function computeSiloedWithdrawalTag(l2Token: AztecAddress): Promise<Fr> {
  const siloedTag = await SiloedTag.computeFromTagAndApp(new Tag(new Fr(WITHDRAWAL_PUBLISHING_TAG)), l2Token);
  return siloedTag.value;
}

/** Decode one `withdrawalPublishing` log, given its fields with the siloed tag first. Throws on a malformed log. */
export function decodePublishedWithdrawal(fields: Fr[]): PublishedWithdrawal {
  const reader = new FieldReader(fields);
  reader.skip(WITHDRAWAL_LOG_TAG_INDEX + 1);
  return {
    executor: reader.readObject(EthAddress),
    userPayloadHash: reader.readField(),
    amount: reader.readField().toBigInt(),
    proverTip: reader.readField().toBigInt(),
    randomness: reader.readField(),
    recipient: reader.readObject(EthAddress),
    relayerTip: reader.readField().toBigInt(),
    signature: {
      sLo: reader.readField(),
      sHi: reader.readField(),
      rLo: reader.readField(),
      rHi: reader.readField(),
    },
  };
}

/** The outbox leaf `OxidePortal.withdraw` consumes for a published withdrawal of `l2Token` to `portal`. */
export function computeWithdrawalMessageHash(args: {
  withdrawal: PublishedWithdrawal;
  l2Token: AztecAddress;
  portal: EthAddress;
  rollupVersion: bigint;
  chainId: bigint;
}): Fr {
  const { withdrawal } = args;
  return computeL2ToL1MessageHash({
    l2Sender: args.l2Token,
    l1Recipient: args.portal,
    content: getWithdrawContentHash(
      withdrawal.executor,
      withdrawal.userPayloadHash,
      withdrawal.amount,
      withdrawal.proverTip,
      withdrawal.randomness,
    ),
    rollupVersion: new Fr(args.rollupVersion),
    chainId: new Fr(args.chainId),
  });
}

/**
 * The id `OxidePortal.$isWithdrawalSpent` records for a withdrawal: `sha256(creation_tx_hash || message_hash)`.
 * The TEE computes the same value when it signs the finalization (`tee-enclave/src/signer.ts`).
 */
export function computeWithdrawalId(creationTxHash: TxHash, messageHash: Fr): Buffer32 {
  return new Buffer32(sha256(Buffer.concat([creationTxHash.toBuffer(), messageHash.toBuffer()])));
}
