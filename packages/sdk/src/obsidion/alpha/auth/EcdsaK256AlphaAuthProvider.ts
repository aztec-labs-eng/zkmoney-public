import { Fr } from "@aztec/aztec.js/fields"
import { AuthWitness } from "@aztec/stdlib/auth-witness"
import { Ecdsa } from "@aztec/foundation/crypto/ecdsa"
import { AlphaAuthProvider } from "./AlphaAuthProvider.js"
import { MAX_WITNESS_LEN } from "../../../utils/constants.js"

const PUBKEY_X_INDEX = 0
const PUBKEY_Y_INDEX = 32
const SIGNATURE_INDEX = 64

/**
 * ECDSA K256 auth provider for alpha account testing.
 *
 * Witness layout:
 *   [0..31]:  pub_key_x (32 bytes)
 *   [32..63]: pub_key_y (32 bytes)
 *   [64..127]: signature (64 bytes)
 */
export class EcdsaK256AlphaAuthProvider implements AlphaAuthProvider {
  constructor(private signingKey: Buffer) {}

  async getPubkeys(): Promise<[Buffer, Buffer]> {
    const publicKey = await new Ecdsa().computePublicKey(this.signingKey)
    return [publicKey.subarray(0, 32), publicKey.subarray(32, 64)]
  }

  async createAuthWit(messageHash: Fr): Promise<AuthWitness> {
    const witness: Fr[] = new Array(MAX_WITNESS_LEN).fill(Fr.ZERO)

    const [pubkeyX, pubkeyY] = await this.getPubkeys()
    for (let i = 0; i < 32; i++) {
      witness[PUBKEY_X_INDEX + i] = new Fr(pubkeyX[i]!)
      witness[PUBKEY_Y_INDEX + i] = new Fr(pubkeyY[i]!)
    }

    const signature = await new Ecdsa().constructSignature(messageHash.toBuffer(), this.signingKey)
    const signatureBytes = [...signature.r, ...signature.s]
    for (let i = 0; i < 64; i++) {
      witness[SIGNATURE_INDEX + i] = new Fr(signatureBytes[i]!)
    }

    return new AuthWitness(messageHash, witness)
  }
}
