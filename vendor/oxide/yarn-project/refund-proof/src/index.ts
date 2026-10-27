// Real proof generation for the frozen_notes_refund circuit, in-process.
//
// Pipeline:
//   1. `Noir.execute` (from `@aztec-foundation/noir-noir_js`) runs ACVM over the circuit and returns the fully
//      solved, gzipped WitnessStack (abiEncode + executeProgram + compressWitnessStack rolled into one).
//   2. `UltraHonkBackend.generateProof` (from `@aztec-foundation/bb.js`) ungzips the witness, runs the WASM
//      Barretenberg backend, and produces an UltraHonk proof.
//
// We pass `verifierTarget: 'evm'` so the proof is a zero-knowledge UltraHonk proof with keccak Fiat-Shamir. This is the
// flavour that the deployed refund verifiers accept. `bb write_solidity_verifier -t evm --optimized` generates them
// from the vk of each circuit, and the optimized verifier accepts the same proofs as the standard one.
import { Barretenberg, UltraHonkBackend } from '@aztec-foundation/bb.js';
import { type InputMap, Noir } from '@aztec-foundation/noir-noir_js';
import { Fr } from '@aztec-labs/foundation/curves/bn254';

import { FrozenDepositsRefundCircuit } from './frozen_deposits_refund/artifact.js';
import { buildFrozenDepositsRefundNoirInput } from './frozen_deposits_refund/noir_input.js';
import type {
  FrozenDepositsRefundProofInput,
  FrozenDepositsRefundProofOptions,
} from './frozen_deposits_refund/types.js';
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
export { FrozenDepositsRefundCircuit } from './frozen_deposits_refund/artifact.js';
export {
  MAX_FROZEN_DEPOSITS_PER_REFUND,
  RefundInputDeposit,
  type FrozenDepositsRefundProofInput,
  type FrozenDepositsRefundProofOptions,
} from './frozen_deposits_refund/types.js';
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
  const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'evm' });
  return { proof: Buffer.from(proof), publicInputs: publicInputs.map(Fr.fromHexString) };
}

/** Run the frozen-deposits-refund circuit; returns the proof + public inputs for
 *  `FrozenDepositsRefundVerifier.HonkVerifier.verify`. */
export async function generateFrozenDepositsRefundProof(
  input: FrozenDepositsRefundProofInput,
  options: FrozenDepositsRefundProofOptions = {},
): Promise<RefundProofData> {
  const inputMap = buildFrozenDepositsRefundNoirInput(input) as InputMap;
  const { witness } = await new Noir(FrozenDepositsRefundCircuit).execute(inputMap);

  const barretenberg = await Barretenberg.initSingleton({ logger: options.logger?.verbose });
  const backend = new UltraHonkBackend(FrozenDepositsRefundCircuit.bytecode, barretenberg);
  const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'evm' });
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
  const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'evm' });
  return { proof: Buffer.from(proof), publicInputs: publicInputs.map(Fr.fromHexString) };
}
