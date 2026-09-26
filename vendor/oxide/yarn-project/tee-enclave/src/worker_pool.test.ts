import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { EnclaveWorkerData } from './worker_data.js';
import { WorkerPool } from './worker_pool.js';

const TEST_ENTRY = new URL('./testing/pool_test_worker.ts', import.meta.url);
// The fixture ignores workerData, so key material is not needed.
const NO_WORKER_DATA = {} as EnclaveWorkerData;

describe('WorkerPool', () => {
  let pool: WorkerPool | undefined;

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
  });

  it('serves more concurrent requests than workers', async () => {
    pool = new WorkerPool(2, NO_WORKER_DATA, TEST_ENTRY);
    await pool.start();
    const requests = Array.from({ length: 8 }, (_, i) => `req-${i}`);
    const responses = await Promise.all(requests.map(text => pool!.dispatch(Buffer.from(text))));
    expect(responses).toEqual(requests.map(text => text.toUpperCase()));
  });

  it('interleaves requests on one worker when an earlier request awaits', async () => {
    pool = new WorkerPool(1, NO_WORKER_DATA, TEST_ENTRY);
    await pool.start();
    const settled: string[] = [];
    const slow = pool.dispatch(Buffer.from('sleep:200')).then(r => settled.push(r));
    const quick = pool.dispatch(Buffer.from('quick')).then(r => settled.push(r));
    await Promise.all([slow, quick]);
    expect(settled).toEqual(['QUICK', 'SLEEP:200']);
  });

  it('rejects new requests once closed', async () => {
    pool = new WorkerPool(1, NO_WORKER_DATA, TEST_ENTRY);
    await pool.start();
    await pool.close();
    await expect(pool.dispatch(Buffer.from('late'))).rejects.toThrow('worker pool is closed');
  });

  // The signature-budget self-destruct relies on this escalation: an exhausted worker exits and the
  // pool must take the whole enclave down with it (worker_entry.ts).
  it('exits the process when a worker dies outside close()', async () => {
    pool = new WorkerPool(1, NO_WORKER_DATA, TEST_ENTRY);
    await pool.start();
    let resolveExit!: (code: unknown) => void;
    const exited = new Promise(resolve => (resolveExit = resolve));
    const exit = jest.spyOn(process, 'exit').mockImplementation((code => resolveExit(code)) as never);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      void pool.dispatch(Buffer.from('exit')).catch(() => {});
      expect(await exited).toBe(1);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
