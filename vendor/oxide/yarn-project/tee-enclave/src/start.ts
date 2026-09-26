// Enclave-runtime entry point. `main.ts` wires `NsmAttestationProvider` and calls
// `startEnclave(provider)` to set up env reading, portal-context derivation, key generation,
// the request worker pool, and the RPC server.
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { EthAddress } from '@aztec/stdlib/block';

import type { AttestationProvider } from '@oxide/oxide-lib/attestation_provider.js';
import type { PortalContext } from '@oxide/oxide-lib/types.js';

import { availableParallelism } from 'node:os';

import { startRpcServer } from './rpc.js';
import { SignatureBudget } from './signature_budget.js';
import { createEnclaveKeyMaterial, toWorkerData } from './worker_data.js';
import { WorkerPool } from './worker_pool.js';

const LISTEN_PORT = parseInt(process.env.OXIDE_TEE_LISTEN_PORT ?? '5001', 10);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var ${name} — see scripts/.env.example`);
  }
  return v;
}

function portalContextFromEnv(): PortalContext {
  return {
    l1Portal: EthAddress.fromString(requireEnv('PORTAL_ADDRESS')),
    l1ChainId: BigInt(requireEnv('L1_CHAIN_ID')),
    l2Portal: AztecAddress.fromStringUnsafe(requireEnv('L2_TOKEN_ADDRESS')),
    rollupVersion: BigInt(requireEnv('ROLLUP_VERSION')),
  };
}

/**
 * Boot the enclave runtime against the supplied attestation provider. Reads portal context from
 * env, generates ephemeral keys, fetches the boot attestation, spawns the request worker pool
 * (one worker per logical cpu), and starts the TCP RPC server on loopback. Resolves once the
 * server is listening; rejects on bind or worker-boot error.
 */
export async function startEnclave(attestationProvider: AttestationProvider): Promise<void> {
  const portalContext = portalContextFromEnv();
  console.log(
    `[oxide-tee enclave] portal: l1Portal=${portalContext.l1Portal} l1ChainId=${portalContext.l1ChainId} ` +
      `l2Portal=${portalContext.l2Portal} rollupVersion=${portalContext.rollupVersion}`,
  );

  const material = await createEnclaveKeyMaterial(attestationProvider);
  const { userData } = material.attestation;
  console.log(
    `[oxide-tee enclave] generated keys ` +
      `secp256k1Pub=(${userData.publicKeyX.toString()}, ${userData.publicKeyY.toString()})`,
  );

  const budget = SignatureBudget.create();
  console.log(`[oxide-tee enclave] signature budget: ${budget.effectiveLimit}`);

  const workerCount = availableParallelism();
  const pool = new WorkerPool(workerCount, toWorkerData(material, portalContext, budget));
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
