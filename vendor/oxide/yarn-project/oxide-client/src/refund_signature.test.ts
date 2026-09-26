/**
 * `buildRefundAuthorization` is the single point where a passkey assertion enters the refund flow, so it is where the
 * P-256 signature becomes canonical. These tests pin that: what the signer emits is normalised, and bytes that are not
 * a signature stop the flow.
 */
import { Fr } from '@aztec/foundation/curves/bn254';

import type { PasskeyPublicKey, PasskeySigner, WebAuthnAuth } from '@oxide/oxide-lib/account_address.js';

import { describe, expect, it } from '@jest/globals';

import { PermanentError } from './errors.js';
import { buildRefundAuthorization } from './refund_signature.js';

// The two forms of one P-256 signature: `s_low + s_high` is the curve order, and only `s_low` is at most half of it.
const R = 'cc373c505a3e689a64d0548f0766e6f5f368d1570fe03819d818b9eeb077531a';
const S_LOW = '61e59a8c9c0c7e38cbee296f44df3be18dec796c3c0123edc9d1ee8992f003d9';
const S_HIGH = '9e1a657263f381c83411d690bb20c41e2efa81416b167a9729e7dc3969732178';

const LOW_S_SIGNATURE = Buffer.from(R + S_LOW, 'hex');
const HIGH_S_SIGNATURE = Buffer.from(R + S_HIGH, 'hex');

const PASSKEY: PasskeyPublicKey = { x: Buffer.alloc(32, 1), y: Buffer.alloc(32, 2) };

/**
 * A signer that always returns the same assertion. `buildRefundAuthorization` verifies nothing, so only `signature`
 * has to be realistic.
 */
function fakeSigner(signature: Buffer): PasskeySigner {
  return {
    publicKey: PASSKEY,
    sign: (_message: Fr): Promise<WebAuthnAuth> =>
      Promise.resolve({
        authenticatorData: Buffer.alloc(37, 3),
        clientDataJSON: Buffer.from('{"type":"webauthn.get"}', 'utf8'),
        signature,
      }),
  };
}

describe('buildRefundAuthorization', () => {
  it('normalises a high-s signature from the authenticator', async () => {
    const auth = await buildRefundAuthorization({ kind: 'passkey', signer: fakeSigner(HIGH_S_SIGNATURE) }, new Fr(7));

    expect(auth.kind).toEqual('passkey');
    if (auth.kind !== 'passkey') {
      throw new Error('unreachable');
    }
    expect(auth.webauthn.signature).toEqual(LOW_S_SIGNATURE);
  });

  it('leaves a low-s signature unchanged', async () => {
    const auth = await buildRefundAuthorization({ kind: 'passkey', signer: fakeSigner(LOW_S_SIGNATURE) }, new Fr(7));

    expect(auth.kind).toEqual('passkey');
    if (auth.kind !== 'passkey') {
      throw new Error('unreachable');
    }
    expect(auth.webauthn.signature).toEqual(LOW_S_SIGNATURE);
  });

  it('rejects a malformed signature permanently', async () => {
    const signer = fakeSigner(Buffer.alloc(32));

    await expect(buildRefundAuthorization({ kind: 'passkey', signer }, new Fr(7))).rejects.toThrow(PermanentError);
  });
});
