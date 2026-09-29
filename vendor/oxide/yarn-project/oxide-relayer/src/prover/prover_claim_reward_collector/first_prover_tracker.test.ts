import { CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { EthAddress } from '@aztec/foundation/eth-address';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { CapturedRange, FirstProverTracker } from './first_prover_tracker.js';

interface Recorded {
  checkpointNumber: CheckpointNumber;
  prover: EthAddress;
  l1BlockNumber: bigint;
}

// The epoch model shared by every test: epoch 0 holds checkpoints 1..EPOCH_LEN.
const EPOCH_LEN = 10;

describe('FirstProverTracker', () => {
  let ours: EthAddress;
  let other: EthAddress;

  beforeEach(() => {
    ours = EthAddress.random();
    other = EthAddress.random();
    // Far below every capture in these tests, so no checkpoint log reads as overwritten unless a test says so.
    pendingCheckpoint = CheckpointNumber(0);
  });

  let tracker: FirstProverTracker | undefined;
  afterEach(async () => {
    await tracker?.stop();
    tracker = undefined;
  });

  const capture = (checkpoint: number, prover: EthAddress, block: bigint): Recorded => ({
    checkpointNumber: CheckpointNumber(checkpoint),
    prover,
    l1BlockNumber: block,
  });

  // Serves FirstProverRecorded events from a pre-sorted list, filtered like the real Portal query. Every event
  // query's args are pushed to `recordedQueries` so a test can inspect the scan.
  const makePortal = (events: Recorded[], head: bigint) => {
    const recordedQueries: any[] = [];
    let currentHead = head;
    return {
      recordedQueries,
      setHead: (n: bigint) => {
        currentHead = n;
      },
      client: {
        getBlockNumber: () => Promise.resolve(currentHead),
      },
      getFirstProverRecordedEvents: (args: any) => {
        recordedQueries.push(args);
        const { prover, checkpointNumber, fromBlock, toBlock } = args;
        return Promise.resolve(
          events.filter(
            e =>
              (prover === undefined || e.prover.equals(prover)) &&
              (checkpointNumber === undefined || e.checkpointNumber === checkpointNumber) &&
              (fromBlock === undefined || e.l1BlockNumber >= fromBlock) &&
              (toBlock === undefined || e.l1BlockNumber <= toBlock),
          ),
        );
      },
    } as any;
  };

  // Pending tip the overwrite check reads. Tests that exercise an overwritten log override it.
  let pendingCheckpoint = CheckpointNumber(0);

  const rollup = {
    getEpochNumberForCheckpoint: () => Promise.resolve(EpochNumber(0)),
    getCheckpointNumber: () => Promise.resolve(pendingCheckpoint),
  } as any;

  // roundaboutSize = epochDuration(4) * (proofSubmissionEpochs(1) + 1) + 1 = 9.
  const ROUNDABOUT_SIZE = 9;

  const node = {
    getCheckpointsData: ({ epoch: _epoch }: any) =>
      Promise.resolve(Array.from({ length: EPOCH_LEN }, (_, i) => ({ checkpointNumber: CheckpointNumber(i + 1) }))),
    getCheckpoints: (start: CheckpointNumber, length: number) =>
      Promise.resolve(
        Array.from({ length }, (_, i) => ({
          archive: undefined,
          header: undefined,
          blocks: [],
          number: CheckpointNumber(start + i),
          feeAssetPriceModifier: 0n,
        })),
      ),
  } as any;

  interface StartOptions {
    events: Recorded[];
    head: bigint;
    fromBlock: bigint;
    maxBlockRange?: bigint;
    rollup?: any;
    roundaboutSize?: number;
  }

  const newTracker = (options: StartOptions) =>
    new FirstProverTracker({
      proverId: ours,
      portal: makePortal(options.events, options.head),
      rollup: options.rollup ?? rollup,
      node,
      fromBlock: options.fromBlock,
      confirmations: 0n,
      maxBlockRange: options.maxBlockRange ?? 10_000n,
      pollIntervalMs: 10,
      roundaboutSize: options.roundaboutSize ?? ROUNDABOUT_SIZE,
    });

  // Start the tracker and resolve once it has emitted `count` ranges, returning them in emission order.
  const collectRanges = async (options: StartOptions, count: number): Promise<CapturedRange[]> => {
    const ranges: CapturedRange[] = [];
    let resolve!: () => void;
    const emitted = new Promise<void>(r => (resolve = r));

    tracker = newTracker(options);
    await tracker.start({
      onRange: range => {
        ranges.push(range);
        if (ranges.length >= count) {
          resolve();
        }
        return Promise.resolve();
      },
    });
    await emitted;
    return ranges;
  };

  const firstRange = async (options: StartOptions): Promise<CapturedRange> => (await collectRanges(options, 1))[0];

  it('starts a range above another prover who captured in the same L1 block', async () => {
    // Block 100 recorded our capture at 3, then another prover at 5; block 200 recorded ours at 8.
    const events = [capture(3, ours, 100n), capture(5, other, 100n), capture(8, ours, 200n)];

    const ranges = await collectRanges({ events, head: 1000n, fromBlock: 0n }, 2);

    // Our second range must start above the other prover's exclusive [4, 5], not at 4.
    expect(ranges[1].epoch).toBe(0);
    expect(ranges[1].rangeStartCheckpoint).toBe(6);
  });

  it('starts a range above our own previous capture', async () => {
    const events = [capture(3, ours, 100n), capture(8, ours, 200n)];

    const ranges = await collectRanges({ events, head: 1000n, fromBlock: 0n }, 2);

    expect(ranges[0].rangeStartCheckpoint).toBe(1);
    expect(ranges[1].rangeStartCheckpoint).toBe(4);
  });

  it('starts a range above an earlier capture by another prover', async () => {
    const events = [capture(5, other, 100n), capture(8, ours, 200n)];

    const range = await firstRange({ events, head: 1000n, fromBlock: 0n });

    expect(range.rangeStartCheckpoint).toBe(6);
  });

  it('emits every one of our captures recorded in the same L1 block', async () => {
    // Block 100 recorded ours@3, other@5, ours@7; block 200 recorded ours@9.
    const events = [capture(3, ours, 100n), capture(5, other, 100n), capture(7, ours, 100n), capture(9, ours, 200n)];

    const ranges = await collectRanges({ events, head: 1000n, fromBlock: 0n }, 3);

    expect(ranges[1].rangeStartCheckpoint).toBe(6);
    expect(ranges[1].epochCheckpoints.at(-1)!.number).toBe(7);
    expect(ranges[2].rangeStartCheckpoint).toBe(8);
    expect(ranges[2].epochCheckpoints.at(-1)!.number).toBe(9);
  });

  it('emits a range again after a restart, since nothing is remembered across one', async () => {
    const events = [capture(3, ours, 100n)];
    const options = { events, head: 1000n, fromBlock: 0n };

    const first = await firstRange(options);
    await tracker!.stop();
    const second = await firstRange(options);

    expect(second.rangeStartCheckpoint).toBe(first.rangeStartCheckpoint);
    expect(second.epochCheckpoints.at(-1)!.number).toBe(3);
  });

  it('emits no ranges when an event batch is not strictly ascending', async () => {
    // Out-of-order captures (bad RPC / deep reorg): ours@5 in block 300 then ours@4 in block 301.
    const events = [capture(5, ours, 300n), capture(4, ours, 301n)];

    let called = false;
    tracker = newTracker({ events, head: 1000n, fromBlock: 0n });
    await tracker.start({
      onRange: () => {
        called = true;
        return Promise.resolve();
      },
    });

    await new Promise(r => setTimeout(r, 150));
    expect(called).toBe(false);
  });

  it('rescans the unconfirmed startup window once it confirms', async () => {
    // fromBlock 1000 sits within confirmations(15) of head 1010, so the confirmed head is 995. Our capture at
    // block 997 is inside the reorgable window (995, 1000): no scan may read it before it buries
    // confirmations-deep, and the poll must pick it up after that.
    const events = [capture(7, ours, 997n)];
    const portalContract = makePortal(events, 1010n);
    tracker = new FirstProverTracker({
      proverId: ours,
      portal: portalContract,
      rollup,
      node,
      fromBlock: 1000n,
      confirmations: 15n,
      maxBlockRange: 10_000n,
      pollIntervalMs: 10,
      roundaboutSize: ROUNDABOUT_SIZE,
    });

    let range: CapturedRange | undefined;
    await tracker.start({
      onRange: r => {
        range = r;
        return Promise.resolve();
      },
    });

    // Block 997 is not yet confirmed, so nothing emits and no query reached past the confirmed head 995.
    await new Promise(r => setTimeout(r, 50));
    expect(range).toBeUndefined();
    for (const q of portalContract.recordedQueries) {
      if (q.toBlock !== undefined) {
        expect(q.toBlock).toBeLessThanOrEqual(995n);
      }
    }

    // Advance the head so 997 buries 15 deep (safeHead 998); the poll now rescans the clamped-off window.
    portalContract.setHead(1013n);
    while (range === undefined) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(range.rangeStartCheckpoint).toBe(1);
    expect(range.epochCheckpoints.at(-1)!.number).toBe(7);
  });

  it('floors the startup clamp at genesis on a chain younger than confirmations', async () => {
    // Head 5 with confirmations 15 makes the confirmed head negative; the cursor must floor at -1 so no scan
    // query ever starts below block 0.
    const events = [capture(3, ours, 2n)];
    const portalContract = makePortal(events, 5n);
    tracker = new FirstProverTracker({
      proverId: ours,
      portal: portalContract,
      rollup,
      node,
      fromBlock: 100n,
      confirmations: 15n,
      maxBlockRange: 10_000n,
      pollIntervalMs: 10,
      roundaboutSize: ROUNDABOUT_SIZE,
    });

    let range: CapturedRange | undefined;
    await tracker.start({
      onRange: r => {
        range = r;
        return Promise.resolve();
      },
    });

    // Advance the head so block 2 buries 15 deep (safeHead 5); the poll scans from genesis.
    portalContract.setHead(20n);
    while (range === undefined) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(range.rangeStartCheckpoint).toBe(1);
    expect(range.epochCheckpoints.at(-1)!.number).toBe(3);
    for (const q of portalContract.recordedQueries) {
      if (q.fromBlock !== undefined) {
        expect(q.fromBlock).toBeGreaterThanOrEqual(0n);
      }
    }
  });
  describe('overwritten checkpoint logs', () => {
    // Wait until `check` holds, or give up after ~500ms so a failure reports the assertion, not a timeout.
    const until = async (check: () => boolean | Promise<boolean>): Promise<void> => {
      for (let i = 0; i < 50; i++) {
        if (await check()) {
          return;
        }
        await new Promise(r => setTimeout(r, 10));
      }
    };

    it('skips a capture the rollup can no longer read, and keeps the ones behind it', async () => {
      // Capture at 3 is unreadable once pending reaches 3 + roundaboutSize(9) = 12; capture at 4 still reads.
      pendingCheckpoint = CheckpointNumber(12);
      const ranges: CapturedRange[] = [];

      tracker = newTracker({ events: [capture(3, ours, 100n), capture(4, ours, 200n)], head: 1000n, fromBlock: 0n });
      await tracker.start({
        onRange: range => {
          ranges.push(range);
          return Promise.resolve();
        },
      });

      await until(() => ranges.length > 0);
      // The tips at 3 are gone, but the capture must not block the ones behind it.
      expect(ranges).toHaveLength(1);
      expect(ranges[0].epochCheckpoints.at(-1)!.number).toBe(4);
    });

    it('skips when the checkpoint log is overwritten between the check and the read', async () => {
      // The pre-check sees a live tip, then the tip crosses the boundary before the epoch lookup lands.
      let reads = 0;
      const racing = {
        ...rollup,
        getCheckpointNumber: () => Promise.resolve(CheckpointNumber(reads++ === 0 ? 5 : 12)),
        getEpochNumberForCheckpoint: (checkpoint: CheckpointNumber) =>
          checkpoint === 3
            ? Promise.reject(new Error('Rollup__UnavailableTempCheckpointLog'))
            : Promise.resolve(EpochNumber(0)),
      };
      const ranges: CapturedRange[] = [];

      tracker = newTracker({
        events: [capture(3, ours, 100n), capture(4, ours, 200n)],
        head: 1000n,
        fromBlock: 0n,
        rollup: racing,
      });
      await tracker.start({
        onRange: range => {
          ranges.push(range);
          return Promise.resolve();
        },
      });

      // The skip must not halt the tracker: the capture behind the skipped one still emits.
      await until(() => ranges.length > 0);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].epochCheckpoints.at(-1)!.number).toBe(4);
    });

    it('still halts on a read failure that is not an overwritten log', async () => {
      // The tip stays well inside the window, so the failure is a real fault and must stop progress.
      const failing = {
        ...rollup,
        getCheckpointNumber: () => Promise.resolve(CheckpointNumber(5)),
        getEpochNumberForCheckpoint: () => Promise.reject(new Error('node is lagging')),
      };
      const ranges: CapturedRange[] = [];

      tracker = newTracker({
        events: [capture(3, ours, 100n), capture(4, ours, 200n)],
        head: 1000n,
        fromBlock: 0n,
        rollup: failing,
      });
      await tracker.start({
        onRange: range => {
          ranges.push(range);
          return Promise.resolve();
        },
      });

      // Neither the failed capture nor the one behind it is handed on.
      await new Promise(r => setTimeout(r, 100));
      expect(ranges).toHaveLength(0);
    });
  });
});
