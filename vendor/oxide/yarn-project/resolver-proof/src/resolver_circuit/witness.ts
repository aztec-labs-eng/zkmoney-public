import { type InputMap, Noir } from '@aztec-foundation/noir-noir_js';

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { ResolverCircuit, ResolverCircuitPath } from './artifact.js';

const PROVER_FILE = 'Prover.json';
// noir-execute writes `<output-dir>/<witness-name>.gz`.
const OUTPUT_WITNESS_NAME = 'output_witness';

/**
 * Solves the circuit, returning the decompressed witness bb proves over. `noirExecuteBinaryPath` picks the native
 * solver, which produces the same witness as the wasm solver byte for byte and runs faster; absent → the in-process
 * wasm solver bundled with noir_js.
 */
export async function generateWitness(inputMap: InputMap, noirExecuteBinaryPath?: string): Promise<Buffer> {
  if (noirExecuteBinaryPath === undefined) {
    const { witness } = await new Noir(ResolverCircuit).execute(inputMap);
    return gunzipSync(witness);
  }

  // The solver reads and writes files, and concurrent resolves must not share any of them. The artifact is the pinned
  // JSON on disk, read-only.
  const dir = await mkdtemp(join(tmpdir(), 'resolver-noir-execute-'));
  try {
    const proverPath = join(dir, PROVER_FILE);
    // noir-execute takes the inputs in ABI form, which the input map already is.
    await writeFile(proverPath, JSON.stringify(inputMap));
    await runNoirExecute(noirExecuteBinaryPath, [
      'execute',
      '--artifact-path',
      ResolverCircuitPath,
      '--prover-file',
      proverPath,
      '--output-dir',
      dir,
      '--witness-name',
      OUTPUT_WITNESS_NAME,
    ]);
    const witnessPath = join(dir, `${OUTPUT_WITNESS_NAME}.gz`);
    try {
      return gunzipSync(await readFile(witnessPath));
    } catch (err) {
      throw new Error(
        `noir-execute at ${noirExecuteBinaryPath} exited 0 but did not produce a readable witness at ${witnessPath}: ${(err as Error).message}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runNoirExecute(binaryPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('error', err => reject(new Error(`could not run noir-execute at ${binaryPath}: ${err.message}`)));
    child.once('close', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`noir-execute exited with ${code ?? signal}: ${output.trim()}`)),
    );
  });
}
