import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import type { Logger } from '@aztec-labs/foundation/log';

import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, it } from '@jest/globals';

import { type L1OperationOwnership, L1OperationRouter, type RoutedDeployment } from './l1_operation_router.js';

type Operation = Parameters<L1OperationOwnership['owns']>[0];

/** A logger that records the info messages. */
function recordingLog() {
  const info: string[] = [];
  return { info, log: { info: (m: string) => info.push(m) } as unknown as Logger };
}

describe('L1OperationRouter', () => {
  const shared = AztecAddress.fromBigIntUnsafe(1n);
  const alone = AztecAddress.fromBigIntUnsafe(2n);
  const dai = EthAddress.random();
  const sUsds = EthAddress.random();
  const worker = (label: string, token: EthAddress, broadcaster = shared): RoutedDeployment => ({
    label,
    publicConfig: { portal: EthAddress.random(), token, broadcaster },
  });
  const immediate = (payoutToken: EthAddress): Operation => ({
    target: EthAddress.random(),
    payoutToken,
    condition: L1OperationCondition.immediate(),
  });

  /** Adds a worker and attaches a store, as `runRelayer` does when the worker starts. */
  function start(router: L1OperationRouter, deployment: RoutedDeployment) {
    router.addWorker(deployment);
    router.attachStore(deployment, { getPendingL1Operation: () => Promise.resolve(undefined) });
  }

  /** The labels of the workers that own `operation` on `broadcaster`. */
  function owners(router: L1OperationRouter, workers: RoutedDeployment[], operation: Operation) {
    return workers.filter(item => router.ownershipFor(item).owns(operation)).map(item => item.label);
  }

  it('gives a withdrawal finalization to the worker of the Portal that it targets, whatever it pays out in', () => {
    const router = new L1OperationRouter(recordingLog().log);
    const workers = [worker('dai', dai), worker('susds', sUsds)];
    workers.forEach(item => start(router, item));
    // An unstake from the sUSDS Portal pays out in DAI but only the sUSDS worker can finalize it.
    const finalization = {
      target: workers[1]!.publicConfig.portal,
      payoutToken: dai,
      condition: L1OperationCondition.messageInOutbox(),
    };
    expect(owners(router, workers, finalization)).toEqual(['susds']);
    const unknown = { ...finalization, target: EthAddress.random() };
    expect(owners(router, workers, unknown)).toEqual([]);
  });

  it('gives another operation to the first worker whose token is the payout token', () => {
    const router = new L1OperationRouter(recordingLog().log);
    const workers = [worker('susds', sUsds), worker('dai-v5', dai), worker('dai-v6', dai)];
    workers.forEach(item => start(router, item));
    expect(owners(router, workers, immediate(dai))).toEqual(['dai-v5']);
    expect(owners(router, workers, immediate(sUsds))).toEqual(['susds']);
    const balance = { ...immediate(dai), condition: L1OperationCondition.balance(dai, EthAddress.random()) };
    expect(owners(router, workers, balance)).toEqual(['dai-v5']);
  });

  it('gives an operation that pays out in no worker token to the first worker on the broadcaster', () => {
    const router = new L1OperationRouter(recordingLog().log);
    const workers = [worker('susds', sUsds), worker('dai', dai)];
    workers.forEach(item => start(router, item));
    expect(owners(router, workers, immediate(EthAddress.random()))).toEqual(['susds']);
  });

  it('keeps each broadcaster apart, so a worker alone on its broadcaster owns all of its operations', () => {
    const router = new L1OperationRouter(recordingLog().log);
    const workers = [worker('dai', dai), worker('other-dai', dai, alone)];
    workers.forEach(item => start(router, item));
    const other = workers[1]!;
    const ownership = router.ownershipFor(other);
    expect(ownership.owns(immediate(dai))).toBe(true);
    expect(ownership.owns(immediate(EthAddress.random()))).toBe(true);
    expect(router.ownershipFor(workers[0]!).owns(immediate(dai))).toBe(true);
  });

  it('never gives an operation to a worker added later', () => {
    const router = new L1OperationRouter(recordingLog().log);
    const first = worker('dai-v5', dai);
    start(router, first);
    const later = worker('dai-v6', dai);
    start(router, later);
    expect(router.ownershipFor(first).owns(immediate(dai))).toBe(true);
    expect(router.ownershipFor(later).owns(immediate(dai))).toBe(false);
  });

  it('makes a worker added later the owner of its own token when no earlier worker has that token', () => {
    const router = new L1OperationRouter(recordingLog().log);
    const first = worker('dai', dai);
    start(router, first);
    // Before the sUSDS worker is added, the first worker owns sUSDS-paid operations through the fallback rule.
    expect(router.ownershipFor(first).owns(immediate(sUsds))).toBe(true);

    const later = worker('susds', sUsds);
    start(router, later);
    expect(router.ownershipFor(first).owns(immediate(sUsds))).toBe(false);
    expect(router.ownershipFor(later).owns(immediate(sUsds))).toBe(true);
  });

  it('adds a known worker once, and logs once that deployments share the broadcaster', () => {
    const { info, log } = recordingLog();
    const router = new L1OperationRouter(log);
    const first = worker('dai-v5', dai);
    const later = worker('dai-v6', dai);
    start(router, first);
    start(router, later);
    router.addWorker(later);
    expect(router.ownershipFor(later).owns(immediate(dai))).toBe(false);
    expect(info).toEqual([
      `deployments dai-v5, dai-v6 share broadcaster ${shared.toString()}; each of their L1 operations goes to one worker`,
    ]);
  });

  it('lets only a running worker own operations, so a worker that cannot start holds up none', () => {
    const router = new L1OperationRouter(recordingLog().log);
    const susds = worker('susds', sUsds);
    const oldDai = worker('dai-v4', dai);
    const newDai = worker('dai-v6', dai);
    start(router, susds);
    // The oldest DAI deployment is added first but its worker never starts, for example because its enclave is gone.
    router.addWorker(oldDai);
    start(router, newDai);
    expect(owners(router, [susds, oldDai, newDai], immediate(dai))).toEqual(['dai-v6']);
    // A finalization whose Portal has no running worker is owned by no worker until that worker starts.
    const finalization = {
      ...immediate(dai),
      target: oldDai.publicConfig.portal,
      condition: L1OperationCondition.messageInOutbox(),
    };
    expect(owners(router, [susds, oldDai, newDai], finalization)).toEqual([]);

    // When the old worker starts, it owns the DAI operations again, being earlier in the order.
    router.attachStore(oldDai, { getPendingL1Operation: () => Promise.resolve(undefined) });
    expect(owners(router, [susds, oldDai, newDai], immediate(dai))).toEqual(['dai-v4']);
    expect(owners(router, [susds, oldDai, newDai], finalization)).toEqual(['dai-v4']);
    // A worker that stops owns nothing again.
    router.detachStore(oldDai);
    expect(owners(router, [susds, oldDai, newDai], immediate(dai))).toEqual(['dai-v6']);
  });

  describe('saved operations', () => {
    /** A store that holds the operations with the IDs in `held`. */
    const storeHolding = (...held: string[]) => ({
      getPendingL1Operation: (operationId: string) =>
        Promise.resolve(held.includes(operationId) ? ({ operationId } as never) : undefined),
    });
    const saved = (payoutToken: EthAddress) => ({
      operationId: `0x${'ab'.repeat(32)}` as const,
      ...immediate(payoutToken),
    });

    it('lets the old owner give way when a refresh adds a new owner that holds the same pending operation', async () => {
      const router = new L1OperationRouter(recordingLog().log);
      // Only a DAI worker runs, so it saved an sUSDS-paid operation through the fallback rule.
      const daiWorker = worker('dai', dai);
      router.addWorker(daiWorker);
      const operation = saved(sUsds);
      router.attachStore(daiWorker, storeHolding(operation.operationId));
      await expect(router.ownershipFor(daiWorker).givesWayTo(operation)).resolves.toBeUndefined();

      // The manifest refresher adds an sUSDS worker, which read the broadcast while it was unproven.
      const susdsWorker = worker('susds', sUsds);
      router.addWorker(susdsWorker);
      router.attachStore(susdsWorker, storeHolding(operation.operationId));
      await expect(router.ownershipFor(daiWorker).givesWayTo(operation)).resolves.toBe('susds');
      // The new owner never gives way for its own operation.
      await expect(router.ownershipFor(susdsWorker).givesWayTo(operation)).resolves.toBeUndefined();
    });

    it('keeps the operation with the worker that saved it when the owner does not hold it or is not running', async () => {
      const router = new L1OperationRouter(recordingLog().log);
      const daiWorker = worker('dai', dai);
      const susdsWorker = worker('susds', sUsds);
      router.addWorker(daiWorker);
      router.addWorker(susdsWorker);
      const operation = saved(sUsds);
      const ownership = router.ownershipFor(daiWorker);

      // The owner started after the broadcast was proven, so it never read the operation.
      router.attachStore(susdsWorker, storeHolding());
      await expect(ownership.givesWayTo(operation)).resolves.toBeUndefined();

      // The owner is not running.
      router.attachStore(susdsWorker, storeHolding(operation.operationId));
      router.detachStore(susdsWorker);
      await expect(ownership.givesWayTo(operation)).resolves.toBeUndefined();
    });

    it('settles copies that workers of one token saved before routing: each gives way to the first worker', async () => {
      const router = new L1OperationRouter(recordingLog().log);
      const workers = [worker('dai-v4', dai), worker('dai-v5', dai), worker('dai-v6', dai)];
      const operation = saved(dai);
      for (const item of workers) {
        router.addWorker(item);
        router.attachStore(item, storeHolding(operation.operationId));
      }
      const owners = await Promise.all(workers.map(item => router.ownershipFor(item).givesWayTo(operation)));
      expect(owners).toEqual([undefined, 'dai-v4', 'dai-v4']);
    });
  });
});
