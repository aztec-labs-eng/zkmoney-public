import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

import type { Secp256k1Point } from '@oxide/resolver-lib/secp256k1_point.js';

export interface ResolutionProofInput {
  day: number;
  nonce: number;
  userPublicKey: Secp256k1Point;
  resolverPublicKey: Secp256k1Point;
  userL2Address: AztecAddress;
  resolverPrivateKey: Uint8Array;
}

export interface ResolutionProofOptions {
  logger?: (msg: string) => void;
  /** Proving thread count; absent → the bb default (min(16, cores)). */
  threads?: number;
  /** Native `noir-execute` binary solving the witness; absent → the wasm solver bundled with noir_js. */
  noirExecuteBinaryPath?: string;
}

export interface ResolutionProof {
  proof: Buffer;
  publicInputs: `0x${string}`[];
}
