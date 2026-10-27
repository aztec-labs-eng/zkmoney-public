// Enclave-runtime entry point. `main.ts` wires `NsmAttestationProvider` and calls `startEnclave(provider)`.
import type { AttestationProvider } from '@oxide/oxide-lib-tee/attestation_provider.js';

import { availableParallelism } from 'node:os';

import { startRpcServer } from './rpc.js';
import { SignatureBudget } from './signature_budget.js';
import { createEnclaveKeyMaterial, toWorkerData } from './worker_data.js';
import { WorkerPool } from './worker_pool.js';

const LISTEN_PORT = parseInt(process.env.OXIDE_TEE_LISTEN_PORT ?? '5001', 10);

/**
 * Boot the enclave runtime: generate ephemeral keys, fetch the boot attestation, spawn the request worker pool, and
 * start the TCP RPC server on loopback. Resolves once the server is listening.
 */
export async function startEnclave(attestationProvider: AttestationProvider): Promise<void> {
  const material = await createEnclaveKeyMaterial(attestationProvider);
  const { userData } = material.attestation;
  console.log(
    `[oxide-tee enclave] generated keys ` +
      `secp256k1Pub=(${userData.publicKeyX.toString()}, ${userData.publicKeyY.toString()})`,
  );

  const budget = SignatureBudget.create();
  console.log(`[oxide-tee enclave] signature budget: ${budget.effectiveLimit}`);

  const workerCount = availableParallelism();
  const pool = new WorkerPool(workerCount, toWorkerData(material, budget));
  await pool.start();
  console.log(`[oxide-tee enclave] ${workerCount} request workers ready`);

  const server = startRpcServer(
    payload => pool.dispatch(payload),
    { host: '127.0.0.1', port: LISTEN_PORT },
    err => console.error('[oxide-tee enclave] socket error:', err),
  );
  server.on('listening', () => {
    console.log(`[oxide-tee enclave] listening on 127.0.0.1:${LISTEN_PORT}`);
  });
  server.on('error', err => {
    console.error('[oxide-tee enclave] server error:', err);
    process.exit(1);
  });
}
