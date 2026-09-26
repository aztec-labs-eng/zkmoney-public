import { toBigIntBE, toBufferBE } from '@aztec/foundation/bigint-buffer';
import { EthAddress } from '@aztec/foundation/eth-address';
import { AztecAddress } from '@aztec/stdlib/aztec-address';

import { MAX_NONCE } from '@oxide/oxide-lib/oxide_constants.gen.js';
import { computeRecipientCommitment } from '@oxide/oxide-lib/recipient_commitment.js';

import { describe, expect, test } from '@jest/globals';

import { secp256k1 } from './libsecp256k1.js';
import { computeSharedSecretSalt, deriveRecoveryCommitment } from './resolution.js';
import { SECP256K1_ORDER, Secp256k1Point } from './secp256k1_point.js';

// Copy of the `valid()` fixture in resolver_circuit/src/main.nr, pinning this implementation
// to the circuit.
const fixture = {
  day: 20000,
  nonce: 42,
  userPublicKey: new Secp256k1Point(
    0x88e2ddeb04657dbd0edadf9c1f98da3b3895faa1f00527934dd35d17542ffe9bn,
    0x1e7640d7737e24e36d208effb77e86affe670a9a497aa7fb52bf4e687a17fff4n,
  ),
  resolverPublicKey: new Secp256k1Point(
    0xbb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020dn,
    0xecddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4n,
  ),
  userL2Address: 0x0ead00000000000000000000000000000000000000000000000000000000bee0n,
  resolverPrivateKey: toBufferBE(0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn, 32),
  expectedSharedSecretSalt: 0x00bbabe215b1c7a1ccf8abc5196bd9bcd584403fcaad9322edda988f9899e7fbn,
  expectedRecipientCommitment: 0x2d2b85117fb7b9c18c24f74d964a952070dc83713469c0493c8ac1bcbed0e171n,
  userL1Account: '0x1111111111111111111111111111111111111111',
  expectedRecoveryCommitment: '0x00c80adf676663c935a008fdc96572839c4816ea6564c2e7cb71f9bd87498cf3',
};

function basePointMul(scalar: bigint): Secp256k1Point {
  return Secp256k1Point.fromSec1(secp256k1.publicKeyCreate(toBufferBE(scalar, 32), false));
}

describe('circuit fixture', () => {
  test('fixture is self-consistent', () => {
    expect(basePointMul(toBigIntBE(fixture.resolverPrivateKey))).toEqual(fixture.resolverPublicKey);
  });

  test('derives the shared secret salt of the circuit fixture', () => {
    const sharedSecretSalt = computeSharedSecretSalt(
      fixture.userPublicKey,
      fixture.resolverPrivateKey,
      fixture.day,
      fixture.nonce,
    );
    expect(sharedSecretSalt.toBigInt()).toBe(fixture.expectedSharedSecretSalt);
  });

  test('derives the recipient commitment of the circuit fixture', async () => {
    const sharedSecretSalt = computeSharedSecretSalt(
      fixture.userPublicKey,
      fixture.resolverPrivateKey,
      fixture.day,
      fixture.nonce,
    );
    const recipientCommitment = await computeRecipientCommitment(
      sharedSecretSalt,
      AztecAddress.fromBigIntUnsafe(fixture.userL2Address),
    );
    expect(recipientCommitment.toBigInt()).toBe(fixture.expectedRecipientCommitment);
  });

  test('derives the recovery commitment of the fixture account', () => {
    const sharedSecretSalt = computeSharedSecretSalt(
      fixture.userPublicKey,
      fixture.resolverPrivateKey,
      fixture.day,
      fixture.nonce,
    );
    const recoveryCommitment = deriveRecoveryCommitment(sharedSecretSalt, EthAddress.fromString(fixture.userL1Account));
    expect(recoveryCommitment.toString()).toBe(fixture.expectedRecoveryCommitment);
  });
});

describe('computeSharedSecretSalt', () => {
  test('is symmetric between resolver and user', () => {
    const userPrivateKey = 0xa11cen;
    const resolverPrivateKey = 0xb0bn;
    const asResolver = computeSharedSecretSalt(
      basePointMul(userPrivateKey),
      toBufferBE(resolverPrivateKey, 32),
      123,
      4,
    );
    const asUser = computeSharedSecretSalt(basePointMul(resolverPrivateKey), toBufferBE(userPrivateKey, 32), 123, 4);
    expect(asResolver.toBigInt()).toBe(asUser.toBigInt());
  });

  test('differs across days and nonces', () => {
    const base = computeSharedSecretSalt(fixture.userPublicKey, fixture.resolverPrivateKey, 123, 4);
    const otherDay = computeSharedSecretSalt(fixture.userPublicKey, fixture.resolverPrivateKey, 124, 4);
    const otherNonce = computeSharedSecretSalt(fixture.userPublicKey, fixture.resolverPrivateKey, 123, 5);
    expect(base.toBigInt()).not.toBe(otherDay.toBigInt());
    expect(base.toBigInt()).not.toBe(otherNonce.toBigInt());
  });

  test('rejects a nonce at MAX_NONCE, like the circuit', () => {
    expect(() =>
      computeSharedSecretSalt(fixture.userPublicKey, fixture.resolverPrivateKey, fixture.day, MAX_NONCE),
    ).toThrow('nonce out of range');
  });

  test('rejects an off-curve public key', () => {
    const offCurve = new Secp256k1Point(fixture.userPublicKey.x, fixture.userPublicKey.y + 1n);
    expect(() => computeSharedSecretSalt(offCurve, fixture.resolverPrivateKey, fixture.day, fixture.nonce)).toThrow(
      'point not on curve',
    );
  });

  test('rejects a private key outside the scalar field', () => {
    expect(() =>
      computeSharedSecretSalt(fixture.userPublicKey, toBufferBE(0n, 32), fixture.day, fixture.nonce),
    ).toThrow('private key not in field');
    expect(() =>
      computeSharedSecretSalt(fixture.userPublicKey, toBufferBE(SECP256K1_ORDER, 32), fixture.day, fixture.nonce),
    ).toThrow('private key not in field');
  });
});

describe('Secp256k1Point', () => {
  test('assertOnCurve rejects an off-curve point', () => {
    const onCurve = new Secp256k1Point(fixture.userPublicKey.x, fixture.userPublicKey.y);
    expect(() => onCurve.assertOnCurve()).not.toThrow();
    const offCurve = new Secp256k1Point(fixture.userPublicKey.x, fixture.userPublicKey.y + 1n);
    expect(() => offCurve.assertOnCurve()).toThrow('point not on curve');
  });

  test('round-trips through SEC1', () => {
    const roundTripped = Secp256k1Point.fromSec1(fixture.userPublicKey.toSec1());
    expect(roundTripped).toEqual(fixture.userPublicKey);
  });

  // Vectors from the eth_address_of_{2,3}g tests in resolver_circuit/src/helpers.nr.
  test('toEthAddress matches the address of 2*G', () => {
    expect(basePointMul(2n).toEthAddress().toString()).toBe('0x2b5ad5c4795c026514f8317c7a215e218dccd6cf');
  });

  test('toEthAddress matches the address of 3*G', () => {
    expect(basePointMul(3n).toEthAddress().toString()).toBe('0x6813eb9362372eef6200f3b1dbc3f819671cba69');
  });
});
