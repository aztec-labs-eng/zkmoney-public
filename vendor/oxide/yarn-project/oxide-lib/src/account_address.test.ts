import { Fr } from '@aztec/aztec.js/fields';

import { describe, expect, it } from '@jest/globals';

import {
  type PasskeyPublicKey,
  type WebAuthnAuth,
  computePasskeyImmutablesHash,
  computeWebAuthnChallenge,
  verifyWebAuthnAuth,
} from './account_address.js';
import { P256_CURVE_ORDER } from './p256_signature.js';

// Vectors pinned in `noir-projects/oxide_lib/src/account_address.nr` and `webauthn.nr`, and in
// `deploy-lib/src/passkey_test_account/stub_passkey_signer.test.ts`. If one of these tests fails, the TS and the Noir
// implementations disagree.
const PINNED_IMMUTABLES_HASH = Fr.fromString('0x2ec7aa3dafb41e9b61288d8d83d3e22f82b044ac7ad4ad606f1bf7a110e3dc49');

const TEST_PASSKEY: PasskeyPublicKey = {
  x: Buffer.from('d8cd12ea5c67f2f8a00c1124893edcfa6754c4d6cede6be13bdf2295c810a97f', 'hex'),
  y: Buffer.from('a5a89d2d2a360c0ca9a4d6c7c9ed4b28d3e199d6627f2e696d689c310a5b0f48', 'hex'),
};
const TEST_CHALLENGE = Fr.fromString('0x18380a3a4dec4daa04fe30592fa1f43bce1fb7e07fbcf136954ce1d9ce76cf98');
const TEST_ASSERTION: WebAuthnAuth = {
  authenticatorData: Buffer.from('06cc72c2e66ce5754ea5792ba3919b3e4935e7019a1723e25cabde1134efc6f90500000007', 'hex'),
  clientDataJSON: Buffer.from(
    '{"type":"webauthn.get","challenge":"GDgKOk3sTaoE_jBZL6H0O84ft-B_vPE2lUzh2c52z5g","origin":"https://stub.passkey.test","crossOrigin":false}',
    'utf8',
  ),
  signature: Buffer.from(
    'cc373c505a3e689a64d0548f0766e6f5f368d1570fe03819d818b9eeb077531a61e59a8c9c0c7e38cbee296f44df3be18dec796c3c0123edc9d1ee8992f003d9',
    'hex',
  ),
};

describe('computePasskeyImmutablesHash', () => {
  it('matches the vector pinned in oxide_lib::account_address', async () => {
    const x = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
    const y = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xff - i));
    expect(await computePasskeyImmutablesHash({ x, y })).toEqual(PINNED_IMMUTABLES_HASH);
  });
});

describe('verifyWebAuthnAuth', () => {
  it('accepts the vector pinned in oxide_lib::webauthn', async () => {
    expect(computeWebAuthnChallenge(TEST_CHALLENGE)).toEqual('GDgKOk3sTaoE_jBZL6H0O84ft-B_vPE2lUzh2c52z5g');
    expect(await verifyWebAuthnAuth(TEST_PASSKEY, TEST_CHALLENGE, TEST_ASSERTION)).toBe(true);
  });

  it('rejects another challenge', async () => {
    expect(await verifyWebAuthnAuth(TEST_PASSKEY, TEST_CHALLENGE.add(Fr.ONE), TEST_ASSERTION)).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const signature = Buffer.from(TEST_ASSERTION.signature);
    signature[0] ^= 0x01;
    expect(await verifyWebAuthnAuth(TEST_PASSKEY, TEST_CHALLENGE, { ...TEST_ASSERTION, signature })).toBe(false);
  });

  it('rejects tampered authenticator data', async () => {
    const authenticatorData = Buffer.from(TEST_ASSERTION.authenticatorData);
    authenticatorData[36] = 0x08;
    expect(await verifyWebAuthnAuth(TEST_PASSKEY, TEST_CHALLENGE, { ...TEST_ASSERTION, authenticatorData })).toBe(
      false,
    );
  });

  it('rejects an assertion without user verification', async () => {
    const authenticatorData = Buffer.from(TEST_ASSERTION.authenticatorData);
    // Pinned flags are 0x05 (user present and user verified). Keep user presence only.
    authenticatorData[32] = 0x01;
    expect(await verifyWebAuthnAuth(TEST_PASSKEY, TEST_CHALLENGE, { ...TEST_ASSERTION, authenticatorData })).toBe(
      false,
    );
  });

  it('rejects an assertion without user presence', async () => {
    const authenticatorData = Buffer.from(TEST_ASSERTION.authenticatorData);
    // Keep user verification only.
    authenticatorData[32] = 0x04;
    expect(await verifyWebAuthnAuth(TEST_PASSKEY, TEST_CHALLENGE, { ...TEST_ASSERTION, authenticatorData })).toBe(
      false,
    );
  });

  it('rejects another passkey', async () => {
    const x = Buffer.from(TEST_PASSKEY.x);
    x[0] ^= 0x01;
    expect(await verifyWebAuthnAuth({ ...TEST_PASSKEY, x }, TEST_CHALLENGE, TEST_ASSERTION)).toBe(false);
  });

  it('rejects a clientDataJSON with a different type', async () => {
    const clientDataJSON = Buffer.from(
      TEST_ASSERTION.clientDataJSON.toString('utf8').replace('webauthn.get', 'webauthn.cre'),
      'utf8',
    );
    expect(await verifyWebAuthnAuth(TEST_PASSKEY, TEST_CHALLENGE, { ...TEST_ASSERTION, clientDataJSON })).toBe(false);
  });

  it('accepts the high-s form of the pinned assertion', async () => {
    // ECDSA signatures are malleable: `(r, n - s)` is as valid as `(r, s)`, and nothing makes an authenticator emit
    // the low-s form. `@noble/curves` confirms that this vector, `TEST_ASSERTION.signature` with `s` replaced by
    // `n - s`, verifies under `p256.verify(..., { lowS: false })`. The circuit accepts only the low-s bytes and the
    // client normalises before it builds the witness, but this verifier stays deliberately looser, so do not make it
    // mirror the circuit here.
    const signature = Buffer.from(
      'cc373c505a3e689a64d0548f0766e6f5f368d1570fe03819d818b9eeb077531a9e1a657263f381c83411d690bb20c41e2efa81416b167a9729e7dc3969732178',
      'hex',
    );
    expect(await verifyWebAuthnAuth(TEST_PASSKEY, TEST_CHALLENGE, { ...TEST_ASSERTION, signature })).toBe(true);
  });

  it('rejects a signature whose s is the curve order', async () => {
    // WebCrypto rejects an out-of-range scalar on its own; this verifier needs no guard of its own.
    const signature = Buffer.concat([
      TEST_ASSERTION.signature.subarray(0, 32),
      Buffer.from(P256_CURVE_ORDER.toString(16), 'hex'),
    ]);
    expect(await verifyWebAuthnAuth(TEST_PASSKEY, TEST_CHALLENGE, { ...TEST_ASSERTION, signature })).toBe(false);
  });

  it('rejects a registration ceremony', async () => {
    // A registration ceremony writes `{"type":"webauthn.create","challenge":"`, which is three characters longer, so
    // the challenge and every later field move. The prefix check runs before the signature check, so this vector does
    // not have to carry a valid signature.
    const clientDataJSON = Buffer.from(
      TEST_ASSERTION.clientDataJSON.toString('utf8').replace('webauthn.get', 'webauthn.create'),
      'utf8',
    );
    expect(await verifyWebAuthnAuth(TEST_PASSKEY, TEST_CHALLENGE, { ...TEST_ASSERTION, clientDataJSON })).toBe(false);
  });

  it('rejects an unterminated challenge', async () => {
    // Signed vector from the same stub passkey over a 33-byte challenge: the 32 bytes of `TEST_CHALLENGE` and one more
    // byte whose top two bits are zero. Its 44 base64url characters start with the 43 characters of the pinned
    // challenge, so every other check passes and only the closing quote rejects it.
    const clientDataJSON = Buffer.from(
      '{"type":"webauthn.get","challenge":"GDgKOk3sTaoE_jBZL6H0O84ft-B_vPE2lUzh2c52z5gq","origin":"https://stub.passkey.test","crossOrigin":false}',
      'utf8',
    );
    const signature = Buffer.from(
      'ab5d20b05be46d82708b33de42166b07edfa472c53a1e52b49588af8f2d85ba102562ab729772df5e5d15a26b8cce7f21599931e29d7d2120182f573959f2f3f',
      'hex',
    );
    expect(
      await verifyWebAuthnAuth(TEST_PASSKEY, TEST_CHALLENGE, { ...TEST_ASSERTION, clientDataJSON, signature }),
    ).toBe(false);
  });
});
