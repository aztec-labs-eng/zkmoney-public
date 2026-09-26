import { BackendType, Barretenberg, BarretenbergSync } from '@aztec/bb.js';

import { type MessagePort, parentPort, workerData } from 'node:worker_threads';

import { EnclaveSession, processFrame } from './rpc.js';
import { type EnclaveWorkerData, fromWorkerData } from './worker_data.js';
import type { WorkerPoolMessage, WorkerRequest } from './worker_pool.js';

async function main(port: MessagePort): Promise<void> {
  await Barretenberg.initSingleton({ backend: BackendType.Wasm, threads: 1, /* no outbound network */ srsSize: 1 });
  await BarretenbergSync.initSingleton({ backend: BackendType.Wasm });

  // Exiting here takes the whole enclave down via the pool's exit handler, killing the key with it.
  const { material, portalContext, budget } = fromWorkerData(workerData as EnclaveWorkerData, () => {
    console.error('[oxide-tee enclave] signature budget exhausted; shutting down');
    setImmediate(() => process.exit(1));
  });
  const session = EnclaveSession.fromKeyMaterial(material, portalContext, budget);

  port.on('message', (msg: WorkerRequest) => {
    // processFrame never throws; every request gets exactly one response message.
    void processFrame(session, Buffer.from(msg.payload)).then(response =>
      port.postMessage({ kind: 'response', id: msg.id, response } satisfies WorkerPoolMessage),
    );
  });
  port.postMessage({ kind: 'ready' });
}

if (!parentPort) {
  throw new Error('worker_entry must run inside a worker thread');
}
main(parentPort).catch(err => {
  console.error('[oxide-tee enclave] worker boot failed:', err);
  process.exit(1);
});
