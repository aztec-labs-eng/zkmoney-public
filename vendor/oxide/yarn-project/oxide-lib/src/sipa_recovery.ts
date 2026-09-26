import { keccak256 } from '@aztec/foundation/crypto/keccak';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { EthAddress } from '@aztec/foundation/eth-address';

export function deriveRecoveryCommitment(sharedSecretSalt: Fr, account: EthAddress): Fr {
  const encoded = Buffer.concat([sharedSecretSalt.toBuffer(), account.toBuffer32()]);
  return Fr.fromBuffer(Buffer.concat([Buffer.alloc(1), keccak256(encoded).subarray(0, 31)]));
}
