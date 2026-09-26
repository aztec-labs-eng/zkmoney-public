import { Buffer32 } from '@aztec/foundation/buffer';
import { keccak256 } from '@aztec/foundation/crypto/keccak';

import { cborArray, cborBytes, cborText, parseCoseSign1 } from './nitro_attestation/parsers.js';

/** Decoded outputs of {@link decodeAttestationTbs}. */
export interface DecodedAttestationTbs {
  /** Sig_structure bytes — exactly what `NitroValidator._verifySignature` SHA-384's and verifies
   *  against the leaf pubkey. Pass as `_attestationTbs` to `portal.registerTee` and as the first
   *  arg to `portal.verifyTeeAttestationHash`. */
  attestationTbs: Buffer;
  /** `keccak256(attestationTbs)` — the lookup key for the staged-hash and staged-leaf maps in
   *  `NitroValidator`, returned by `verifyTeeAttestationHash`. Pass as the first arg to
   *  `portal.verifyTeeAttestationSig`. */
  attestationTbsKeccak: Buffer32;
  /** COSE-Sign1 signature over `attestationTbs` (ECDSA-P384 r||s, 96 bytes). Pass as the second
   *  arg to `portal.verifyTeeAttestationSig` and `portal.registerTee`. */
  signature: Buffer;
}

/**
 * Pure-TS port of `NitroValidator.decodeAttestationTbs` — splits a COSE_Sign1 attestation document
 * into the Sig_structure bytes that get SHA-384'd inside `_verifySignature`, the COSE signature
 * blob, and `keccak256(attestationTbs)` (the staging-map key). Lets callers prepare every input
 * `registerTee` / the two attestation-staging entry points need without a round trip to L1.
 *
 * Construction (RFC 9052 §4.4 Sig_structure for COSE_Sign1):
 *   [ "Signature1", protectedHeadersBstr, externalAad=emptyBstr, payloadBstr ]
 *
 * Matches the on-chain `_constructAttestationTbs` byte-for-byte under canonical CBOR encoding, so
 * the returned `attestationTbsKeccak` agrees with what the validator computes from the same TBS.
 */
export function decodeAttestationTbs(attestation: Buffer): DecodedAttestationTbs {
  const { protectedHeaders, payloadBytes, signature } = parseCoseSign1(attestation);
  const attestationTbs = cborArray([
    cborText('Signature1'),
    cborBytes(protectedHeaders),
    cborBytes(Buffer.alloc(0)),
    cborBytes(payloadBytes),
  ]);
  const attestationTbsKeccak = Buffer32.fromBuffer(keccak256(attestationTbs));
  return { attestationTbs, attestationTbsKeccak, signature };
}
