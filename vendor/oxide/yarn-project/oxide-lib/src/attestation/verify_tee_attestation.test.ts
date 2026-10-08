// Drives the fixture produced by `end-to-end/dest/src/test_utils/tee/gen_test_attestation.js` through `verifyTeeAttestation`
// end-to-end: success, wrong trust anchor, and mismatched user_data. The success case implicitly
// pins the gen script's `user_data` against this package's `computeAttestationUserData` because
// the wrapper recomputes the preimage from the supplied `UserData` and compares it to the parsed
// attestation byte-for-byte.
import { Buffer32 } from '@aztec/foundation/buffer';

import { readFileSync } from 'node:fs';

import type { UserData } from './user_data.js';
import { verifyTeeAttestation } from './verify_tee_attestation.js';

const FIXTURES = new URL('./fixtures/generated/', import.meta.url);

interface Summary {
  timestampMillis: string;
  pcr0: string;
  teePubKeyX: string;
  teePubKeyY: string;
  teeEthAddress: string;
  encPubKeyX: string;
  encPubKeyY: string;
  userData: string;
  rootCertHash: string;
  cabundleCount: number;
}

function fixture(name: string): Buffer {
  return readFileSync(new URL(name, FIXTURES));
}
function summary(): Summary {
  return JSON.parse(readFileSync(new URL('summary.json', FIXTURES), 'utf8')) as Summary;
}
function fromHex(s: string): Buffer {
  return Buffer.from(s.startsWith('0x') ? s.slice(2) : s, 'hex');
}
function summaryUserData(s: Summary): UserData {
  return {
    publicKeyX: Buffer32.fromBuffer(fromHex(s.teePubKeyX)),
    publicKeyY: Buffer32.fromBuffer(fromHex(s.teePubKeyY)),
    encPubKeyX: Buffer32.fromBuffer(fromHex(s.encPubKeyX)),
    encPubKeyY: Buffer32.fromBuffer(fromHex(s.encPubKeyY)),
  };
}

describe('verifyTeeAttestation', () => {
  test('accepts the fixture when supplied with the recorded userData and root', () => {
    const s = summary();
    const parsed = verifyTeeAttestation({
      attestationDocument: fixture('attestation.cose'),
      trustedRootCertificates: [fixture('root.der')],
      userData: summaryUserData(s),
    });
    expect(parsed.userData).toEqual(fromHex(s.userData));
    expect(parsed.caBundle.length).toBe(1 + s.cabundleCount);
  });

  test('rejects when anchored at a non-root cabundle entry', () => {
    expect(() =>
      verifyTeeAttestation({
        attestationDocument: fixture('attestation.cose'),
        trustedRootCertificates: [fixture('cabundle/00.der')],
        userData: summaryUserData(summary()),
      }),
    ).toThrow(/Nitro certificate chain does not terminate in a trusted root/);
  });

  test('rejects when supplied userData does not match the attestation', () => {
    const s = summary();
    expect(() =>
      verifyTeeAttestation({
        attestationDocument: fixture('attestation.cose'),
        trustedRootCertificates: [fixture('root.der')],
        userData: { ...summaryUserData(s), publicKeyX: new Buffer32(Buffer.alloc(32, 0x01)) },
      }),
    ).toThrow(/Nitro user_data does not match expected binding/);
  });
});
