import { CheckpointNumber, EpochNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { CapturedRange, FirstProverTracker } from './first_prover_tracker.js';

// One `L2ProofVerified` log on the rollup: a verified epoch proof that ended at `checkpointNumber`.
interface ProofLog {
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
  });

  let tracker: FirstProverTracker | undefined;
  afterEach(async () => {
    await tracker?.stop();
    tracker = undefined;
  });

  const proof = (checkpoint: number, prover: EthAddress, block: bigint): ProofLog => ({
    checkpointNumber: CheckpointNumber(checkpoint),
    prover,
    l1BlockNumber: block,
  });

  // A rollup that serves `L2ProofVerified` logs from a pre-sorted list, filtered by block range like the real
  // event query. Every query's block range is pushed to `recordedQueries` so a test can inspect the scan.
  // The pending tip is far below every proof unless a test overrides it, so no checkpoint log reads as overwritten.
  const makeRollup = (logs: ProofLog[], head: bigint, overrides: Record<string, unknown> = {}) => {
    const recordedQueries: { fromBlock?: bigint; toBlock?: bigint }[] = [];
    let currentHead = head;
    return {
      recordedQueries,
      setHead: (n: bigint) => {
        currentHead = n;
      },
      client: {
        getBlockNumber: () => Promise.resolve(currentHead),
      },
      getContract: () => ({
        getEvents: {
          L2ProofVerified: (_filter: unknown, range: { fromBlock?: bigint; toBlock?: bigint }) => {
            recordedQueries.push(range);
            return Promise.resolve(
              logs
                .filter(
                  l =>
                    (range.fromBlock === undefined || l.l1BlockNumber >= range.fromBlock) &&
                    (range.toBlock === undefined || l.l1BlockNumber <= range.toBlock),
                )
                .map(l => ({
                  args: { checkpointNumber: BigInt(l.checkpointNumber), proverId: l.prover.toString() },
                  blockNumber: l.l1BlockNumber,
                })),
            );
          },
        },
      }),
      getEpochNumberForCheckpoint: () => Promise.resolve(EpochNumber(0)),
      getCheckpointNumber: () => Promise.resolve(CheckpointNumber(0)),
      ...overrides,
    } as any;
  };

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
    logs: ProofLog[];
    head: bigint;
    fromBlock: bigint;
    maxBlockRange?: bigint;
    rollupOverrides?: Record<string, unknown>;
    roundaboutSize?: number;
  }

  const newTracker = (options: StartOptions) =>
    new FirstProverTracker({
      proverId: ours,
      rollup: makeRollup(options.logs, options.head, options.rollupOverrides),
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

  it('starts a range above another prover who moved the tip in the same L1 block', async () => {
    // Block 100 recorded our proof to 3, then another prover's to 5; block 200 recorded ours to 8.
    const logs = [proof(3, ours, 100n), proof(5, other, 100n), proof(8, ours, 200n)];

    const ranges = await collectRanges({ logs, head: 1000n, fromBlock: 0n }, 2);

    // Our second range must start above the other prover's exclusive [4, 5], not at 4.
    expect(ranges[1].epoch).toBe(0);
    expect(ranges[1].rangeStartCheckpoint).toBe(6);
  });

  it('starts a range above our own previous proof', async () => {
    const logs = [proof(3, ours, 100n), proof(8, ours, 200n)];

    const ranges = await collectRanges({ logs, head: 1000n, fromBlock: 0n }, 2);

    expect(ranges[0].rangeStartCheckpoint).toBe(1);
    expect(ranges[1].rangeStartCheckpoint).toBe(4);
  });

  it('starts a range above an earlier proof by another prover', async () => {
    const logs = [proof(5, other, 100n), proof(8, ours, 200n)];

    const range = await firstRange({ logs, head: 1000n, fromBlock: 0n });

    expect(range.rangeStartCheckpoint).toBe(6);
  });

  it('emits every one of our tip-moving proofs recorded in the same L1 block', async () => {
    // Block 100 recorded ours@3, other@5, ours@7; block 200 recorded ours@9.
    const logs = [proof(3, ours, 100n), proof(5, other, 100n), proof(7, ours, 100n), proof(9, ours, 200n)];

    const ranges = await collectRanges({ logs, head: 1000n, fromBlock: 0n }, 3);

    expect(ranges[1].rangeStartCheckpoint).toBe(6);
    expect(ranges[1].epochCheckpoints.at(-1)!.number).toBe(7);
    expect(ranges[2].rangeStartCheckpoint).toBe(8);
    expect(ranges[2].epochCheckpoints.at(-1)!.number).toBe(9);
  });

  it('emits a range again after a restart, since nothing is remembered across one', async () => {
    const logs = [proof(3, ours, 100n)];
    const options = { logs, head: 1000n, fromBlock: 0n };

    const first = await firstRange(options);
    await tracker!.stop();
    const second = await firstRange(options);

    expect(second.rangeStartCheckpoint).toBe(first.rangeStartCheckpoint);
    expect(second.epochCheckpoints.at(-1)!.number).toBe(3);
  });

  it('ignores our proofs that did not move the proven tip', async () => {
    // The other prover moved the tip to 5. Our later proofs to 3 and to 5 re-prove a proven range, so the rollup
    // recorded no first prover for them. Only our proof to 8 moved the tip.
    const logs = [proof(5, other, 100n), proof(3, ours, 150n), proof(5, ours, 160n), proof(8, ours, 200n)];

    const ranges: CapturedRange[] = [];
    tracker = newTracker({ logs, head: 1000n, fromBlock: 0n });
    await tracker.start({
      onRange: range => {
        ranges.push(range);
        return Promise.resolve();
      },
    });

    await new Promise(r => setTimeout(r, 150));
    expect(ranges).toHaveLength(1);
    expect(ranges[0].rangeStartCheckpoint).toBe(6);
    expect(ranges[0].epochCheckpoints.at(-1)!.number).toBe(8);
  });

  it('rescans the unconfirmed startup window once it confirms', async () => {
    // fromBlock 1000 sits within confirmations(15) of head 1010, so the confirmed head is 995. Our proof at
    // block 997 is inside the reorgable window (995, 1000): no scan may read it before it buries
    // confirmations-deep, and the poll must pick it up after that.
    const logs = [proof(7, ours, 997n)];
    const rollupContract = makeRollup(logs, 1010n);
    tracker = new FirstProverTracker({
      proverId: ours,
      rollup: rollupContract,
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
    for (const q of rollupContract.recordedQueries) {
      if (q.toBlock !== undefined) {
        expect(q.toBlock).toBeLessThanOrEqual(995n);
      }
    }

    // Advance the head so 997 buries 15 deep (safeHead 998); the poll now rescans the clamped-off window.
    rollupContract.setHead(1013n);
    while (range === undefined) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(range.rangeStartCheckpoint).toBe(1);
    expect(range.epochCheckpoints.at(-1)!.number).toBe(7);
  });

  it('floors the startup clamp at genesis on a chain younger than confirmations', async () => {
    // Head 5 with confirmations 15 makes the confirmed head negative; the cursor must floor at -1 so no scan
    // query ever starts below block 0.
    const logs = [proof(3, ours, 2n)];
    const rollupContract = makeRollup(logs, 5n);
    tracker = new FirstProverTracker({
      proverId: ours,
      rollup: rollupContract,
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
    rollupContract.setHead(20n);
    while (range === undefined) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(range.rangeStartCheckpoint).toBe(1);
    expect(range.epochCheckpoints.at(-1)!.number).toBe(3);
    for (const q of rollupContract.recordedQueries) {
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

    it('skips a proof the rollup can no longer read, and keeps the ones behind it', async () => {
      // The proof to 3 is unreadable once pending reaches 3 + roundaboutSize(9) = 12; the proof to 4 still reads.
      const ranges: CapturedRange[] = [];

      tracker = newTracker({
        logs: [proof(3, ours, 100n), proof(4, ours, 200n)],
        head: 1000n,
        fromBlock: 0n,
        rollupOverrides: { getCheckpointNumber: () => Promise.resolve(CheckpointNumber(12)) },
      });
      await tracker.start({
        onRange: range => {
          ranges.push(range);
          return Promise.resolve();
        },
      });

      await until(() => ranges.length > 0);
      // The tips at 3 are gone, but the proof must not block the ones behind it.
      expect(ranges).toHaveLength(1);
      expect(ranges[0].epochCheckpoints.at(-1)!.number).toBe(4);
    });

    it('skips when the checkpoint log is overwritten between the check and the read', async () => {
      // The pre-check sees a live tip, then the tip crosses the boundary before the epoch lookup lands.
      let reads = 0;
      const ranges: CapturedRange[] = [];

      tracker = newTracker({
        logs: [proof(3, ours, 100n), proof(4, ours, 200n)],
        head: 1000n,
        fromBlock: 0n,
        rollupOverrides: {
          getCheckpointNumber: () => Promise.resolve(CheckpointNumber(reads++ === 0 ? 5 : 12)),
          getEpochNumberForCheckpoint: (checkpoint: CheckpointNumber) =>
            checkpoint === 3
              ? Promise.reject(new Error('Rollup__UnavailableTempCheckpointLog'))
              : Promise.resolve(EpochNumber(0)),
        },
      });
      await tracker.start({
        onRange: range => {
          ranges.push(range);
          return Promise.resolve();
        },
      });

      // The skip must not halt the tracker: the proof behind the skipped one still emits.
      await until(() => ranges.length > 0);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].epochCheckpoints.at(-1)!.number).toBe(4);
    });

    it('still halts on a read failure that is not an overwritten log', async () => {
      // The tip stays well inside the window, so the failure is a real fault and must stop progress.
      const ranges: CapturedRange[] = [];

      tracker = newTracker({
        logs: [proof(3, ours, 100n), proof(4, ours, 200n)],
        head: 1000n,
        fromBlock: 0n,
        rollupOverrides: {
          getCheckpointNumber: () => Promise.resolve(CheckpointNumber(5)),
          getEpochNumberForCheckpoint: () => Promise.reject(new Error('node is lagging')),
        },
      });
      await tracker.start({
        onRange: range => {
          ranges.push(range);
          return Promise.resolve();
        },
      });

      // Neither the failed proof nor the one behind it is handed on.
      await new Promise(r => setTimeout(r, 100));
      expect(ranges).toHaveLength(0);
    });
  });
});
