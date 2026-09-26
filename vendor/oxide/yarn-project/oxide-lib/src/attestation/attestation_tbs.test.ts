import { keccak256 } from '@aztec/foundation/crypto/keccak';

import { readFileSync } from 'node:fs';

import { decodeAttestationTbs } from './attestation_tbs.js';
import { parseCoseSign1 } from './nitro_attestation/parsers.js';

const FIXTURES = new URL('./fixtures/nitro/', import.meta.url);

function fixture(name: string): Buffer {
  return readFileSync(new URL(name, FIXTURES));
}

describe('decodeAttestationTbs', () => {
  // Real AWS Nitro attestation — the existing verify_nitro_attestation test confirms its
  // signature ECDSA-verifies against the same Sig_structure construction we now hoist into
  // `decodeAttestationTbs`, so a passing structural check here means the TBS is byte-for-byte
  // what `NitroValidator.decodeAttestationTbs` would produce on-chain.
  const nitroAttestation = fixture('nitro-attestation');

  test('returns the COSE-Sign1 signature (96 bytes for ES384)', () => {
    const { signature } = decodeAttestationTbs(nitroAttestation);
    expect(signature.length).toBe(96);
    expect(signature).toEqual(parseCoseSign1(nitroAttestation).signature);
  });

  test('Sig_structure begins with the 4-array + "Signature1" prefix per RFC 9052 §4.4', () => {
    const { attestationTbs } = decodeAttestationTbs(nitroAttestation);
    // 0x84 = CBOR 4-element array; 0x6a = 10-byte text string header for "Signature1".
    expect(attestationTbs.subarray(0, 12)).toEqual(Buffer.concat([Buffer.of(0x84, 0x6a), Buffer.from('Signature1')]));
  });

  test('attestationTbsKeccak matches keccak256(attestationTbs) — round-trip key derivation', () => {
    const { attestationTbs, attestationTbsKeccak } = decodeAttestationTbs(nitroAttestation);
    expect(attestationTbsKeccak.toBuffer()).toEqual(keccak256(attestationTbs));
  });

  test('result is deterministic across calls', () => {
    const a = decodeAttestationTbs(nitroAttestation);
    const b = decodeAttestationTbs(nitroAttestation);
    expect(a.attestationTbs).toEqual(b.attestationTbs);
    expect(a.signature).toEqual(b.signature);
    expect(a.attestationTbsKeccak.toBuffer()).toEqual(b.attestationTbsKeccak.toBuffer());
  });
});
