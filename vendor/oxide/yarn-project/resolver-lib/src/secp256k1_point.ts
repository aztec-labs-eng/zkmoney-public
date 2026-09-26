import { toBigIntBE, toBufferBE } from '@aztec/foundation/bigint-buffer';
import { keccak256 } from '@aztec/foundation/crypto/keccak';
import { EthAddress } from '@aztec/foundation/eth-address';

import { secp256k1 } from './libsecp256k1.js';

/** secp256k1 group order n. */
export const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export type Secp256k1Coordinates = { x: bigint; y: bigint };

/**
 * Affine secp256k1 point.
 */
export class Secp256k1Point {
  constructor(
    public readonly x: bigint,
    public readonly y: bigint,
  ) {}

  /** Parses a SEC1-encoded public key, compressed or uncompressed. */
  static fromSec1(bytes: Uint8Array): Secp256k1Point {
    const uncompressed = secp256k1.publicKeyConvert(bytes, false);
    return new Secp256k1Point(
      toBigIntBE(Buffer.from(uncompressed.subarray(1, 33))),
      toBigIntBE(Buffer.from(uncompressed.subarray(33, 65))),
    );
  }

  /** Throws unless the point is canonical and on the curve. */
  assertOnCurve(): void {
    if (!secp256k1.publicKeyVerify(this.toSec1())) {
      throw new Error('point not on curve');
    }
  }

  toCoordinates(): Secp256k1Coordinates {
    return { x: this.x, y: this.y };
  }

  /** Serializes to the 65-byte uncompressed SEC1 form (0x04 || x || y). */
  toSec1(): Buffer {
    return Buffer.concat([Buffer.from([0x04]), toBufferBE(this.x, 32), toBufferBE(this.y, 32)]);
  }

  /** Ethereum address of the point: keccak256(x || y), last 20 bytes. */
  toEthAddress(): EthAddress {
    return EthAddress.fromBuffer(keccak256(this.toSec1().subarray(1)).subarray(12));
  }
}
