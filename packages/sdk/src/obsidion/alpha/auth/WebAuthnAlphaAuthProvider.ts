import { Fr } from "@aztec/aztec.js/fields"
import { AuthWitness } from "@aztec/stdlib/auth-witness"
import { AlphaAuthProvider } from "./AlphaAuthProvider.js"
import { MAX_WITNESS_LEN } from "../../../utils/constants.js"

const PUBKEY_X_INDEX = 0
const PUBKEY_Y_INDEX = 32
const SIGNATURE_INDEX = 64
const AUTHENTICATOR_DATA_INDEX = 128
const CLIENT_DATA_JSON_LEN_INDEX = 165
const CLIENT_DATA_JSON_INDEX = 166

/**
 * Authenticator data the witness carries: the fixed WebAuthn header, and nothing after it. An
 * authenticator that signs extension output past that header has signed more than the account
 * contract reconstructs, so a signature over a longer buffer cannot verify against this witness.
 */
export const WITNESS_AUTHENTICATOR_DATA_LEN = CLIENT_DATA_JSON_LEN_INDEX - AUTHENTICATOR_DATA_INDEX

export interface WebAuthnSignResult {
  signature: Uint8Array // 64 bytes
  authenticatorData: Uint8Array // 37 bytes
  clientDataJSON: Uint8Array // variable, max 319 bytes
}

/**
 * WebAuthn P-256 auth provider for alpha account (production).
 *
 * Witness layout:
 *   [0..31]:   pub_key_x (32 bytes)
 *   [32..63]:  pub_key_y (32 bytes)
 *   [64..127]: signature (64 bytes)
 *   [128..164]: authenticator_data (37 bytes)
 *   [165]:     client_data_json_len
 *   [166..484]: client_data_json (319 bytes max)
 */
export class WebAuthnAlphaAuthProvider implements AlphaAuthProvider {
  constructor(
    private pubkeyX: Buffer,
    private pubkeyY: Buffer,
    private signFn: (challenge: Buffer) => Promise<WebAuthnSignResult>,
  ) {}

  async getPubkeys(): Promise<[Buffer, Buffer]> {
    return [this.pubkeyX, this.pubkeyY]
  }

  signChallenge(challenge: Buffer): Promise<WebAuthnSignResult> {
    if (challenge.length !== 32) throw new Error("WebAuthn challenge must be 32 bytes")
    return this.signFn(challenge)
  }

  async createAuthWit(messageHash: Fr): Promise<AuthWitness> {
    const witness: Fr[] = new Array(MAX_WITNESS_LEN).fill(Fr.ZERO)

    for (let i = 0; i < 32; i++) {
      witness[PUBKEY_X_INDEX + i] = new Fr(this.pubkeyX[i]!)
      witness[PUBKEY_Y_INDEX + i] = new Fr(this.pubkeyY[i]!)
    }

    const result = await this.signFn(messageHash.toBuffer())

    // Everything the authenticator signed has to fit the witness, or the digest the account
    // contract rebuilds is not the one that was signed and the signature cannot verify. Refusing
    // here beats emitting a truncated witness whose only symptom is a failed transaction.
    if (result.authenticatorData.length !== WITNESS_AUTHENTICATOR_DATA_LEN) {
      throw new Error(
        `authenticator data is ${result.authenticatorData.length} bytes; the witness carries ` +
          `${WITNESS_AUTHENTICATOR_DATA_LEN}, so this signature cannot be verified`,
      )
    }

    for (let i = 0; i < 64; i++) {
      witness[SIGNATURE_INDEX + i] = new Fr(result.signature[i]!)
    }

    for (let i = 0; i < WITNESS_AUTHENTICATOR_DATA_LEN; i++) {
      witness[AUTHENTICATOR_DATA_INDEX + i] = new Fr(result.authenticatorData[i]!)
    }

    witness[CLIENT_DATA_JSON_LEN_INDEX] = new Fr(result.clientDataJSON.length)

    for (let i = 0; i < result.clientDataJSON.length; i++) {
      witness[CLIENT_DATA_JSON_INDEX + i] = new Fr(result.clientDataJSON[i]!)
    }

    return new AuthWitness(messageHash, witness)
  }
}
