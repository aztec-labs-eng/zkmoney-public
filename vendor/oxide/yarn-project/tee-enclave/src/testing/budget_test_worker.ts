// SignatureBudget test stand-in: hammers `consume()` on the shared counter and reports how many
// succeeded. Spawned directly from source — Node's native type stripping runs it, so the runtime
// import needs the explicit .ts extension.
import { parentPort, workerData } from 'node:worker_threads';

import { SignatureBudget, type SignatureBudgetWorkerData } from '../signature_budget.ts';

const { budget, attempts } = workerData as { budget: SignatureBudgetWorkerData; attempts: number };
const shared = SignatureBudget.fromWorkerData(budget);

let successes = 0;
for (let i = 0; i < attempts; i++) {
  try {
    shared.consume();
    successes++;
  } catch {
    // expected past the limit
  }
}
parentPort!.postMessage(successes);
