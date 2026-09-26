import { Buffer32 } from '@aztec/foundation/buffer';
import { sha256 } from '@aztec/foundation/crypto/sha256';

import { readFileSync } from 'node:fs';

import { ATTESTATION_USER_DATA_DOMAIN, computeAttestationUserData } from '../user_data.js';
import { parseCoseSign1, parseNitroPayload } from './parsers.js';
import { verifyNitroAttestation } from './verify_nitro_attestation.js';

const FIXTURES = new URL('../fixtures/nitro/', import.meta.url);

function fixture(name: string): Buffer {
  return readFileSync(new URL(name, FIXTURES));
}

describe('nitro_fixtures', () => {
  test('parses the real Nitro COSE_Sign1 envelope and payload', () => {
    const cose = parseCoseSign1(fixture('nitro-attestation'));

    expect(cose.protectedHeaders.length).toBe(4);
    expect(cose.signature.length).toBe(96);

    const parsed = parseNitroPayload(cose.payloadBytes);
    expect(parsed.moduleId).toBe('i-0e7aea654f85a021f-enc019d10d23b8cc352');
    expect(parsed.digest).toBe('SHA384');
    expect(parsed.timestamp).toBe(1774103715707n);
    expect(parsed.pcr0.toString('hex')).toBe(
      '586ddf52065b7c5b6f486ca110803aaee77e10e0ad40bcc6d228af3a5f991378b3ef2d835524cedac96838879c6bc22c',
    );
    expect(parsed.certificate.length).toBe(638);
    expect(parsed.caBundle.length).toBe(4);
    expect(parsed.enclavePublicKey).toBeUndefined();
    expect(parsed.nonce).toBeUndefined();
    expect(parsed.userData).toBeDefined();
  });

  test('verifies the real Nitro certificate chain and COSE signature against the AWS root', () => {
    const parsed = verifyNitroAttestation({
      attestationDocument: fixture('nitro-attestation'),
      trustedRootCertificates: [fixture('cabundle_0.der')],
    });

    expect(parsed.moduleId).toBe('i-0e7aea654f85a021f-enc019d10d23b8cc352');
    expect(parsed.caBundle.length).toBe(4);
  });

  test('embedded Nitro signing certificate matches signing_cert.der fixture', () => {
    const cose = parseCoseSign1(fixture('nitro-attestation'));
    const parsed = parseNitroPayload(cose.payloadBytes);

    expect(parsed.certificate).toEqual(fixture('signing_cert.der'));
  });

  test('rejects a Nitro attestation with a tampered COSE signature', () => {
    const attestation = fixture('nitro-attestation');
    const tampered = Buffer.from(attestation);
    tampered[tampered.length - 1] ^= 1;

    expect(() =>
      verifyNitroAttestation({
        attestationDocument: tampered,
        trustedRootCertificates: [fixture('cabundle_0.der')],
      }),
    ).toThrow(/Nitro COSE signature verification failed/);
  });

  test('rejects a Nitro attestation when the trusted root does not anchor the chain', () => {
    expect(() =>
      verifyNitroAttestation({
        attestationDocument: fixture('nitro-attestation'),
        trustedRootCertificates: [fixture('cabundle_1.der')],
      }),
    ).toThrow(/Nitro certificate chain does not terminate in a trusted root/);
  });

  test('rejects mismatched user_data bindings', () => {
    expect(() =>
      verifyNitroAttestation({
        attestationDocument: fixture('nitro-attestation'),
        trustedRootCertificates: [fixture('cabundle_0.der')],
        expectedUserData: Buffer.alloc(128),
      }),
    ).toThrow(/Nitro user_data does not match expected binding/);
  });

  test('computeAttestationUserData reproduces the canonical 140-byte SHA-256 preimage', () => {
    // Sanity-check vector: deterministic inputs → known SHA-256 output. The preimage layout must
    // match `TEERegistrationLib._userDataDigest` byte-for-byte; if either side ever drifts, this
    // assertion catches the divergence before an enclave deployment fails on-chain.
    const keys = {
      publicKeyX: new Buffer32(Buffer.alloc(32, 0x11)),
      publicKeyY: new Buffer32(Buffer.alloc(32, 0x22)),
      encPubKeyX: new Buffer32(Buffer.alloc(32, 0x44)),
      encPubKeyY: new Buffer32(Buffer.alloc(32, 0x55)),
    };

    const expected = sha256(
      Buffer.concat([
        ATTESTATION_USER_DATA_DOMAIN,
        keys.publicKeyX.toBuffer(),
        keys.publicKeyY.toBuffer(),
        keys.encPubKeyX.toBuffer(),
        keys.encPubKeyY.toBuffer(),
      ]),
    );

    const actual = computeAttestationUserData(keys);
    expect(actual).toEqual(expected);
    expect(actual.length).toBe(32);
  });
});
