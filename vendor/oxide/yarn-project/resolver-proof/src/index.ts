import { BackendType, Barretenberg } from '@aztec-foundation/bb.js';
import type { InputMap } from '@aztec-foundation/noir-noir_js';

import { gunzipSync } from 'node:zlib';

import { ResolverCircuit } from './resolver_circuit/artifact.js';
import { buildResolutionNoirInput } from './resolver_circuit/noir_input.js';
import type { ResolutionProof, ResolutionProofInput, ResolutionProofOptions } from './resolver_circuit/types.js';
import { ResolverCircuitVk } from './resolver_circuit/vk.js';
import { generateWitness } from './resolver_circuit/witness.js';

export { ResolverCircuit } from './resolver_circuit/artifact.js';
export type { ResolutionProof, ResolutionProofInput, ResolutionProofOptions } from './resolver_circuit/types.js';

// bb.js's `verifierTarget: 'evm'` settings. Must match the pinned ZK Honk verifier
// (l1-contracts/src/pinned/PinnedResolverVerifier.sol).
const EVM_PROOF_SETTINGS = {
  ipaAccumulation: false,
  oracleHashType: 'keccak',
  disableZk: false,
  optimizedSolidityVerifier: false,
};

const CIRCUIT_BYTECODE = gunzipSync(Buffer.from(ResolverCircuit.bytecode, 'base64'));

export async function generateResolutionProof(
  input: ResolutionProofInput,
  options: ResolutionProofOptions = {},
): Promise<ResolutionProof> {
  const inputMap = buildResolutionNoirInput(input) as InputMap;
  const witness = await generateWitness(inputMap, options.noirExecuteBinaryPath);

  // Supplying the prebuilt vk skips bb's per-prove vk recomputation.
  // Require the native backend so initialization errors cannot silently select WASM.
  const api = await Barretenberg.initSingleton({
    logger: options.logger,
    threads: options.threads,
    backend: BackendType.NativeUnixSocket,
  });
  const { proof, publicInputs } = await api.circuitProve({
    circuit: { name: 'resolver_circuit', bytecode: CIRCUIT_BYTECODE, verificationKey: ResolverCircuitVk },
    witness,
    settings: EVM_PROOF_SETTINGS,
  });
  return {
    proof: Buffer.concat(proof),
    publicInputs: publicInputs.map(pi => `0x${Buffer.from(pi).toString('hex')}` as `0x${string}`),
  };
}
