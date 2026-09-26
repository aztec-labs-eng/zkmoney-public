import { Worker } from 'node:worker_threads';

import { logEnclaveError } from './rpc.js';
import type { EnclaveWorkerData } from './worker_data.js';

interface PendingRequest {
  resolve: (response: string) => void;
  reject: (err: Error) => void;
}

/** Pool → worker: one request frame. */
export interface WorkerRequest {
  id: number;
  payload: Uint8Array;
}

/** Worker → pool: `ready` once after boot, then one `response` per request id. */
export type WorkerPoolMessage = { kind: 'ready' } | { kind: 'response'; id: number; response: string };

/**
 * Pool of request workers, each holding a signer over the shared enclave key material.
 *
 * Every request goes straight to the worker with the fewest outstanding requests, tagged with an
 * id the worker echoes back in its response. Workers are assumed alive for the process lifetime:
 * a worker exiting outside `close()` brings the whole enclave down.
 */
export class WorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private readonly load = new Map<Worker, number>();
  private nextId = 0;
  private closed = false;

  constructor(
    private readonly size: number,
    private readonly workerData: EnclaveWorkerData,
    private readonly entry: URL = new URL('./worker_entry.js', import.meta.url),
  ) {
    if (size < 1) {
      throw new Error(`worker pool size must be >= 1, got ${size}`);
    }
  }

  /** Spawns all workers; resolves once every one is ready to take requests. */
  async start(): Promise<void> {
    await Promise.all(Array.from({ length: this.size }, () => this.spawn()));
  }

  dispatch(payload: Buffer): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error('worker pool is closed'));
    }
    const worker = this.leastLoaded();
    if (!worker) {
      return Promise.reject(new Error('worker pool is not started'));
    }
    this.load.set(worker, this.load.get(worker)! + 1);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, payload } satisfies WorkerRequest);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const req of this.pending.values()) {
      req.reject(new Error('worker pool closed'));
    }
    this.pending.clear();
    await Promise.all(this.workers.map(worker => worker.terminate()));
  }

  private leastLoaded(): Worker | undefined {
    let best: Worker | undefined;
    let bestLoad = Infinity;
    for (const worker of this.workers) {
      const load = this.load.get(worker)!;
      if (load < bestLoad) {
        best = worker;
        bestLoad = load;
      }
    }
    return best;
  }

  /** Resolves once the worker signals ready; rejects if it exits first. */
  private spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(this.entry, { workerData: this.workerData });

      worker.on('message', (msg: WorkerPoolMessage) => {
        if (msg.kind === 'ready') {
          this.workers.push(worker);
          this.load.set(worker, 0);
          resolve();
          return;
        }
        const req = this.pending.get(msg.id);
        if (!req) {
          return;
        }
        this.pending.delete(msg.id);
        this.load.set(worker, this.load.get(worker)! - 1);
        req.resolve(msg.response);
      });

      const die = (cause: unknown) => {
        if (this.closed) {
          return;
        }
        logEnclaveError('worker', cause);
        if (!this.workers.includes(worker)) {
          reject(cause instanceof Error ? cause : new Error(String(cause)));
          return;
        }
        console.error('[oxide-tee enclave] worker exited; shutting down');
        process.exit(1);
      };

      worker.on('error', die);
      worker.on('exit', code => die(new Error(`worker exited with code ${code}`)));
    });
  }
}
