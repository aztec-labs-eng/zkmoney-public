import { AuthWitnessProvider } from "@aztec/entrypoints/interfaces"
import { Fr } from "@aztec/aztec.js/fields"
import { AuthWitness } from "@aztec/stdlib/auth-witness"

/**
 * Auth provider interface for alpha (non-module) accounts.
 *
 * Extends AuthWitnessProvider which provides createAuthWit(messageHash).
 * Adds getPubkeys(): the signing key is committed into the account address, so the account layer
 * derives the address from it.
 *
 * Witness layout (alpha, no module prefix):
 *   [0..31]:  pub_key_x (32 bytes)
 *   [32..63]: pub_key_y (32 bytes)
 *   [64+]:    scheme-specific signature data
 */
export interface AlphaAuthProvider extends AuthWitnessProvider {
  getPubkeys(): Promise<[Buffer, Buffer]>
  createAuthWit(messageHash: Fr): Promise<AuthWitness>
}
