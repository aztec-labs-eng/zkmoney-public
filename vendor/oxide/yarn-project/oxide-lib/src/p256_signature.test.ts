import { describe, expect, it } from '@jest/globals';

import { P256_CURVE_ORDER, normalizeP256Signature } from './p256_signature.js';

/** A 32-byte big-endian buffer for `value`. */
function coord(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
}

function signature(r: bigint, s: bigint): Buffer {
  return Buffer.concat([coord(r), coord(s)]);
}

// The low-s half of the pinned stub-passkey assertion in `account_address.test.ts`.
const PINNED_R = 0xcc373c505a3e689a64d0548f0766e6f5f368d1570fe03819d818b9eeb077531an;
const PINNED_LOW_S = 0x61e59a8c9c0c7e38cbee296f44df3be18dec796c3c0123edc9d1ee8992f003d9n;

describe('P256_CURVE_ORDER', () => {
  it('is the order of the P-256 group', () => {
    expect(P256_CURVE_ORDER).toBe(0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n);
  });
});

describe('normalizeP256Signature', () => {
  it('returns a low-s signature unchanged', () => {
    const lowS = signature(PINNED_R, PINNED_LOW_S);
    expect(normalizeP256Signature(lowS)).toEqual(lowS);
  });

  it('does not change the input buffer', () => {
    const highS = signature(PINNED_R, P256_CURVE_ORDER - PINNED_LOW_S);
    const copy = Buffer.from(highS);
    normalizeP256Signature(highS);
    expect(highS).toEqual(copy);
  });

  it('flips a high-s signature to its low-s form', () => {
    const highS = signature(PINNED_R, P256_CURVE_ORDER - PINNED_LOW_S);
    expect(normalizeP256Signature(highS)).toEqual(signature(PINNED_R, PINNED_LOW_S));
  });

  it('accepts s at exactly half the curve order', () => {
    const halfOrder = signature(PINNED_R, P256_CURVE_ORDER / 2n);
    expect(normalizeP256Signature(halfOrder)).toEqual(halfOrder);
  });

  it('rejects a signature that is not 64 bytes', () => {
    expect(normalizeP256Signature(Buffer.alloc(63))).toBeUndefined();
    expect(normalizeP256Signature(Buffer.alloc(65))).toBeUndefined();
    expect(normalizeP256Signature(Buffer.alloc(0))).toBeUndefined();
  });

  it('rejects a zero r', () => {
    expect(normalizeP256Signature(signature(0n, PINNED_LOW_S))).toBeUndefined();
  });

  it('rejects a zero s', () => {
    expect(normalizeP256Signature(signature(PINNED_R, 0n))).toBeUndefined();
  });

  it('rejects s equal to the curve order', () => {
    expect(normalizeP256Signature(signature(PINNED_R, P256_CURVE_ORDER))).toBeUndefined();
  });

  it('rejects r at or above the curve order', () => {
    expect(normalizeP256Signature(signature(P256_CURVE_ORDER, PINNED_LOW_S))).toBeUndefined();
    expect(normalizeP256Signature(signature(P256_CURVE_ORDER + 1n, PINNED_LOW_S))).toBeUndefined();
  });
});
