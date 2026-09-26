// Real proof generation for the frozen_notes_refund circuit, in-process.
//
// Pipeline:
//   1. `Noir.execute` (from `@aztec/noir-noir_js`) runs ACVM over the circuit and returns the fully
//      solved, gzipped WitnessStack (abiEncode + executeProgram + compressWitnessStack rolled into one).
//   2. `UltraHonkBackend.generateProof` (from `@aztec/bb.js`) ungzips the witness, runs the WASM
//      Barretenberg backend, and produces an UltraHonk proof.
//
// We pass `verifierTarget: 'evm-no-zk'` so the proof matches the flavour the deployed
// `FrozenNotesRefundVerifier.sol::HonkVerifier` accepts (`bb write_solidity_verifier --scheme
// ultra_honk --disable_zk` was used to generate that contract from the circuit's vk).
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import { Fr } from '@aztec/foundation/curves/bn254';
import { type InputMap, Noir } from '@aztec/noir-noir_js';

import { FrozenDepositRefundCircuit } from './frozen_deposit_refund/artifact.js';
import { buildFrozenDepositRefundNoirInput } from './frozen_deposit_refund/noir_input.js';
import type { FrozenDepositRefundProofInput, FrozenDepositRefundProofOptions } from './frozen_deposit_refund/types.js';
import { RefundCircuit } from './frozen_notes_refund/artifact.js';
import { buildNoirInput } from './frozen_notes_refund/noir_input.js';
import type { FrozenNotesRefundProofInput, FrozenNotesRefundProofOptions } from './frozen_notes_refund/types.js';
import { UnprocessedDepositRefundCircuit } from './unprocessed_deposit_refund/artifact.js';
import { buildUnprocessedDepositRefundNoirInput } from './unprocessed_deposit_refund/noir_input.js';
import type {
  UnprocessedDepositRefundProofInput,
  UnprocessedDepositRefundProofOptions,
} from './unprocessed_deposit_refund/types.js';

export { RefundCircuit } from './frozen_notes_refund/artifact.js';
export {
  RefundInputNote,
  type FrozenNotesRefundProofInput,
  type FrozenNotesRefundProofOptions,
} from './frozen_notes_refund/types.js';
export { FrozenDepositRefundCircuit } from './frozen_deposit_refund/artifact.js';
export type { FrozenDepositRefundProofInput, FrozenDepositRefundProofOptions } from './frozen_deposit_refund/types.js';
export { UnprocessedDepositRefundCircuit } from './unprocessed_deposit_refund/artifact.js';
export type {
  UnprocessedDepositRefundProofInput,
  UnprocessedDepositRefundProofOptions,
} from './unprocessed_deposit_refund/types.js';

/** Proof plus the public-inputs vector Barretenberg derives from the witness. */
export interface RefundProofData {
  // A flat Uint8Array of 32-byte field elements with no public inputs prepended.
  proof: Buffer;
  publicInputs: Fr[];
}

/** Run the frozen-notes-refund circuit; returns the proof + public inputs for
 *  `FrozenNotesRefundVerifier.HonkVerifier.verify`. */
export async function generateFrozenNotesRefundProof(
  input: FrozenNotesRefundProofInput,
  options: FrozenNotesRefundProofOptions = {},
): Promise<RefundProofData> {
  const inputMap = buildNoirInput(input) as InputMap;
  const { witness } = await new Noir(RefundCircuit).execute(inputMap);

  const barretenberg = await Barretenberg.initSingleton({ logger: options.logger?.verbose });
  const backend = new UltraHonkBackend(RefundCircuit.bytecode, barretenberg);
  const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'evm-no-zk' });
  return { proof: Buffer.from(proof), publicInputs: publicInputs.map(Fr.fromHexString) };
}

/** Run the frozen-deposit-refund circuit; returns the proof + public inputs for
 *  `FrozenDepositRefundVerifier.HonkVerifier.verify`. */
export async function generateFrozenDepositRefundProof(
  input: FrozenDepositRefundProofInput,
  options: FrozenDepositRefundProofOptions = {},
): Promise<RefundProofData> {
  const inputMap = buildFrozenDepositRefundNoirInput(input) as InputMap;
  const { witness } = await new Noir(FrozenDepositRefundCircuit).execute(inputMap);

  const barretenberg = await Barretenberg.initSingleton({ logger: options.logger?.verbose });
  const backend = new UltraHonkBackend(FrozenDepositRefundCircuit.bytecode, barretenberg);
  const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'evm-no-zk' });
  return { proof: Buffer.from(proof), publicInputs: publicInputs.map(Fr.fromHexString) };
}

/** Run the unprocessed-deposit-refund circuit; returns the proof + public inputs for
 *  `UnprocessedDepositRefundVerifier.HonkVerifier.verify`. */
export async function generateUnprocessedDepositRefundProof(
  input: UnprocessedDepositRefundProofInput,
  options: UnprocessedDepositRefundProofOptions = {},
): Promise<RefundProofData> {
  const inputMap = buildUnprocessedDepositRefundNoirInput(input) as InputMap;
  const { witness } = await new Noir(UnprocessedDepositRefundCircuit).execute(inputMap);

  const barretenberg = await Barretenberg.initSingleton({ logger: options.logger?.verbose });
  const backend = new UltraHonkBackend(UnprocessedDepositRefundCircuit.bytecode, barretenberg);
  const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'evm-no-zk' });
  return { proof: Buffer.from(proof), publicInputs: publicInputs.map(Fr.fromHexString) };
}
