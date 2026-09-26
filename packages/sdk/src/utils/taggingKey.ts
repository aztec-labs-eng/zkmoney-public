import { sha512ToGrumpkinScalar } from "@aztec/foundation/crypto/sha512"
import { GrumpkinScalar } from "@aztec/foundation/curves/grumpkin"
import { Fr } from "@aztec/foundation/curves/bn254"
import { DomainSeparator } from "@aztec/constants"

/**
 * Derive the tagging secret key from the account's master secret.
 * Standard Aztec derivation: sha512ToGrumpkinScalar([secretKey, DomainSeparator.TSK_M]).
 */
export function deriveTaggingSecretKey(secretKey: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([secretKey, DomainSeparator.TSK_M])
}
