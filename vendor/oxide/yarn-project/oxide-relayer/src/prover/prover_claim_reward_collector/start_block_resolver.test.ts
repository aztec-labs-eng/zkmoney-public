import { describe, expect, it } from '@jest/globals';

import { resolveStartBlock } from './start_block_resolver.js';

describe('resolveStartBlock', () => {
  const ROUNDABOUT_SIZE = 9;
  const L1_SLOT = 12;

  // Serves `timestampOf(block)` for each block, by default one block per 12s L1 slot. Every read block is pushed
  // to `probes`.
  const makeClient = (head: bigint, timestampOf = (block: bigint) => block * 12n) => {
    const probes: bigint[] = [];
    return {
      probes,
      getBlockNumber: () => Promise.resolve(head),
      getBlock: ({ blockNumber }: any) => {
        probes.push(blockNumber);
        return Promise.resolve({ timestamp: timestampOf(blockNumber) });
      },
    } as any;
  };

  // Slot k starts at timestamp k * 10, an epoch holds 4 slots, and `checkpointSlots` maps a checkpoint to its
  // slot. Every pinned rollup read is pushed to `calls`.
  const makeRollup = (pending: number, checkpointSlots: Record<number, number>) => {
    const calls: any[] = [];
    return {
      calls,
      getCheckpointNumber: (opts: any) => {
        calls.push(['getCheckpointNumber', opts]);
        return Promise.resolve(pending);
      },
      getEpochDuration: () => Promise.resolve(4),
      getCheckpoint: (n: number, opts: any) => {
        calls.push(['getCheckpoint', n, opts]);
        return Promise.resolve({ slotNumber: checkpointSlots[n] });
      },
      getEpochNumberForSlotNumber: (s: number) => Promise.resolve(Math.floor(s / 4)),
      getTimestampForSlot: (s: number) => Promise.resolve(BigInt(s) * 10n),
    } as any;
  };

  // Pending 20 puts the oldest readable checkpoint at 20 - 9 + 1 = 12. Its slot 50 sits in epoch 12, whose first
  // slot 48 starts at timestamp 480: the floor. The chain checkpoints once per ~4 slots, so the floor is further
  // back than one checkpoint per slot would suggest.
  const makeSlowRollup = () => makeRollup(20, { 12: 50 });

  const resolve = (client: any, rollup: any, maxBlockRange = 200n) =>
    resolveStartBlock({
      client,
      rollup,
      roundaboutSize: ROUNDABOUT_SIZE,
      ethereumSlotDuration: L1_SLOT,
      maxBlockRange,
    });

  it('computes the floor block from the L1 slot time when L1 filled every slot', async () => {
    // Head 1000 at timestamp 12_000 is 11_520s = 960 slots above the floor, so block 40 sits exactly at it.
    const client = makeClient(1000n);

    expect(await resolve(client, makeSlowRollup())).toBe(40n);
    // One read for the head, one to confirm the estimate. No walk.
    expect(client.probes).toEqual([1000n, 40n]);
  });

  it('lands below the floor by the slots L1 missed', async () => {
    // L1 missed 10 slots above block 500, so the head sits 970 slots above the floor but only 960 blocks. The
    // estimate lands 10 blocks below block 40, the last one at or below the floor.
    const client = makeClient(1000n, block => block * 12n + (block > 500n ? 120n : 0n));

    expect(await resolve(client, makeSlowRollup())).toBe(30n);
    expect(client.probes).toEqual([1000n, 30n]);
  });

  it('steps back from the estimate on a chain that mines faster than one block per slot', async () => {
    // One block per second, like anvil. The head is 520s above the floor, so the estimate is 44 blocks below it
    // at block 956, still above the floor. The walk steps back 200 blocks at a time to 356, the first block
    // at or below the floor at timestamp 480.
    const client = makeClient(1000n, block => block);

    expect(await resolve(client, makeSlowRollup())).toBe(356n);
    expect(client.probes).toEqual([1000n, 956n, 756n, 556n, 356n]);
  });

  it('floors at the rollup genesis on a young chain', async () => {
    const client = makeClient(30n);

    // With pending 3 every checkpoint is readable, so the oldest clamps to genesis checkpoint 0 at slot 0.
    const rollup = makeRollup(3, { 0: 0 });
    expect(await resolve(client, rollup)).toBe(0n);
  });

  it('pins the pending read and the log read to the head', async () => {
    const client = makeClient(1000n);
    const rollup = makeSlowRollup();

    await resolve(client, rollup);

    expect(rollup.calls).toContainEqual(['getCheckpointNumber', { blockNumber: 1000n }]);
    expect(rollup.calls).toContainEqual(['getCheckpoint', 12, { blockNumber: 1000n }]);
  });
});
