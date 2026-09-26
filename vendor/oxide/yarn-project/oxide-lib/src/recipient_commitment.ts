// TS mirror of `oxide_lib/src/recipient_commitment.nr`.
import { DomainSeparator } from '@aztec/constants';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import type { Fr } from '@aztec/foundation/curves/bn254';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';

/** The deposit message's secretHash slot: blinds the recipient behind `sharedSecretSalt`, a high-entropy salt known
 *  to the depositing application and the recipient. */
export function computeRecipientCommitment(sharedSecretSalt: Fr, recipient: AztecAddress): Promise<Fr> {
  return poseidon2HashWithSeparator([sharedSecretSalt, recipient.toField()], DomainSeparator.SECRET_HASH);
}
