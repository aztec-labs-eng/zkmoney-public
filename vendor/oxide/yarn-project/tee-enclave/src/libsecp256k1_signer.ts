import { Buffer32 } from '@aztec/foundation/buffer';
import { keccak256 } from '@aztec/foundation/crypto/keccak';
import { EthAddress } from '@aztec/foundation/eth-address';
import { Signature } from '@aztec/foundation/eth-signature';

import type { SecpPublicKey } from '@oxide/oxide-lib/types.js';

import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

// Route through libsecp256k1's native bindings directly. The `secp256k1` package's default
// entry silently falls back to a pure-JS `elliptic` implementation when the native addon
// fails to load — that fallback would defeat the side-channel motivation for this module,
// so loading the bindings subpath instead fails loudly if the addon is missing.
const requireCjs = createRequire(import.meta.url);
const secp: typeof import('secp256k1') = requireCjs('secp256k1/bindings.js');

// Randomize libsecp256k1's projective-coordinate blinding factor. Each scalar mult scrambles
// its intermediate (X, Y, Z) values with this λ, frustrating differential side-channel
// attacks (power/EM/microarchitectural) that combine traces across signings. Orthogonal to
// the constant-time guarantees libsecp256k1 already provides.
secp.contextRandomize(randomBytes(32));

function publicKeyToAddress(publicKey: Buffer): EthAddress {
  const hash = keccak256(publicKey.subarray(1));
  return new EthAddress(hash.subarray(12));
}

export function publicKeyFromPrivateKey(privateKey: Buffer): Buffer {
  return Buffer.from(secp.publicKeyCreate(privateKey, false));
}

/** The uncompressed pubkey (`0x04 || X(32) || Y(32)`) split into its 32-byte coordinates. */
export function secpPublicKeyFromPrivateKey(privateKey: Buffer32): SecpPublicKey {
  const full = publicKeyFromPrivateKey(privateKey.buffer);
  return {
    x: Buffer32.fromBuffer(full.subarray(1, 33)),
    y: Buffer32.fromBuffer(full.subarray(33, 65)),
  };
}

export function addressFromPrivateKey(privateKey: Buffer): EthAddress {
  return publicKeyToAddress(publicKeyFromPrivateKey(privateKey));
}

export function verifyEcdsa(rs: Buffer, digest: Buffer, publicKeyUncompressed: Buffer): boolean {
  return secp.ecdsaVerify(rs, digest, publicKeyUncompressed);
}

/**
 * Drop-in replacement for `@aztec/foundation`'s `Secp256k1Signer` backed by libsecp256k1's
 * constant-time C implementation. libsecp256k1 always emits low-s canonical signatures, so
 * the output bytes are interchangeable with the noble-backed foundation signer for any
 * ECRECOVER-style verifier (Solidity, Noir `k1_verify`).
 */
export class Secp256k1Signer {
  public readonly address: EthAddress;

  constructor(private privateKey: Buffer32) {
    this.address = addressFromPrivateKey(privateKey.buffer);
  }

  sign(message: Buffer32): Signature {
    const { signature, recid } = secp.ecdsaSign(message.buffer, this.privateKey.buffer);
    const r = Buffer32.fromBuffer(Buffer.from(signature.subarray(0, 32)));
    const s = Buffer32.fromBuffer(Buffer.from(signature.subarray(32, 64)));
    return new Signature(r, s, recid ? 28 : 27);
  }

  static random(): Secp256k1Signer {
    return new Secp256k1Signer(Buffer32.random());
  }
}
