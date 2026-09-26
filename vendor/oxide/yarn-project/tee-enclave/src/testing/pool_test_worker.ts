// WorkerPool test stand-in for worker_entry.ts: echoes requests uppercased; 'sleep:<ms>' awaits
// before responding; 'exit' kills the worker without responding. Spawned directly from source —
// Node's native type stripping runs it, so no jest transform or build step applies.
import { setTimeout as sleep } from 'node:timers/promises';
import { parentPort } from 'node:worker_threads';

import type { WorkerPoolMessage, WorkerRequest } from '../worker_pool.js';

parentPort!.on('message', (msg: WorkerRequest) => {
  void (async () => {
    const text = Buffer.from(msg.payload).toString('utf8');
    if (text === 'exit') {
      process.exit(7);
    }
    if (text.startsWith('sleep:')) {
      await sleep(parseInt(text.slice('sleep:'.length), 10));
    }
    parentPort!.postMessage({ kind: 'response', id: msg.id, response: text.toUpperCase() } satisfies WorkerPoolMessage);
  })();
});
parentPort!.postMessage({ kind: 'ready' } satisfies WorkerPoolMessage);
