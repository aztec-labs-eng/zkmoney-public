import { toBigIntBE } from '@aztec-labs/foundation/bigint-buffer';

import type { ResolutionProofInput } from './types.js';

/* eslint-disable camelcase */

const LIMB_MASK = (1n << 128n) - 1n;

export function buildResolutionNoirInput(input: ResolutionProofInput): Record<string, unknown> {
  if (input.resolverPrivateKey.length !== 32) {
    throw new Error(`resolver private key must be 32 bytes, got ${input.resolverPrivateKey.length}`);
  }
  const resolverPrivateKey = toBigIntBE(Buffer.from(input.resolverPrivateKey));
  // Keys and nesting must match noir-projects/resolver_circuit/src/main.nr.
  return {
    day: input.day.toString(),
    user_public_key: mapK1Point(input.userPublicKey),
    resolver_public_key: mapK1Point(input.resolverPublicKey),
    user_l2_address: { inner: hex(input.userL2Address.toBigInt()) },
    resolver_private_key: {
      scalar_lo: hex(resolverPrivateKey & LIMB_MASK),
      scalar_hi: hex(resolverPrivateKey >> 128n),
    },
    nonce: input.nonce.toString(),
  };
}

function mapK1Point(point: { x: bigint; y: bigint }): Record<string, string> {
  return {
    xlo: hex(point.x & LIMB_MASK),
    xhi: hex(point.x >> 128n),
    ylo: hex(point.y & LIMB_MASK),
    yhi: hex(point.y >> 128n),
  };
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}
