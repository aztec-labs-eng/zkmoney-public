import { Buffer32 } from '@aztec/foundation/buffer';
import { keccak256 } from '@aztec/foundation/crypto/keccak';

import { parseCoseSign1, parseNitroPayload } from './nitro_attestation/parsers.js';

/**
 * Extracts the 48-byte PCR0 measurement from a raw AWS Nitro COSE_Sign1 attestation document.
 * Convenience wrapper over `parseCoseSign1` + `parseNitroPayload` for callers that only need
 * the enclave image hash (e.g. operator scripts populating the on-chain approved-PCR0 list).
 */
export function getPcr0(attestation: Buffer): Buffer {
  const { payloadBytes } = parseCoseSign1(attestation);
  return parseNitroPayload(payloadBytes).pcr0;
}

/**
 * Computes the SHA-256 hash of a 48-byte PCR0 measurement.
 */
export function hashPcr0(pcr0: Buffer): Buffer32 {
  return Buffer32.fromString(keccak256(pcr0).toString('hex'));
}

/**
 * Retrieves the 48-byte PCR0 measurement from a raw AWS Nitro COSE_Sign1 attestation document, then computes the
 * SHA-256 hash of it.
 */
export function getPcr0Hash(attestation: Buffer): Buffer32 {
  return hashPcr0(getPcr0(attestation));
}
