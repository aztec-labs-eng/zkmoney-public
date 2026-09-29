import { RollupContract } from '@aztec/ethereum/contracts/rollup';
import { ViemClient } from '@aztec/ethereum/types';
import { maxBigint } from '@aztec/foundation/bigint';
import { CheckpointNumber, SlotNumber } from '@aztec/foundation/branded-types';
import { Logger, createLogger } from '@aztec/foundation/log';

export interface ResolveStartBlockOptions {
  client: ViemClient;
  rollup: RollupContract;
  /** Size of the rollup's circular checkpoint-log buffer. */
  roundaboutSize: number;
  /** L1 slot duration in seconds. */
  ethereumSlotDuration: number;
  /** Blocks stepped per probe on a chain that mines faster than one block per slot. */
  maxBlockRange: bigint;
  log?: Logger;
}

/**
 * The L1 block the FirstProverTracker should scan from: a block at or below the floor, the earliest L1 timestamp
 * at which a FirstProverRecorded event can still matter. L1 timestamps strictly increase, so no block below the
 * returned one holds a relevant capture.
 *
 * The collector keeps no progress across restarts: a claim outlives at most one checkpoint-log window, so every
 * start replays whatever is still claimable and rediscovers it. Replay costs nothing but RPC reads, since the
 * batch submitter drops claims already recorded on chain before it builds a batch.
 *
 * Each L1 block takes its own slot, so the block `k` blocks below the head is at least `k` slots older. The block
 * `ceil((headTs - floorTs) / slotDuration)` blocks below the head is thus at or below the floor, and it is lower
 * than necessary only by the slots that L1 missed. A dev chain such as anvil can mine more than one block per
 * slot, so the estimate can land above the floor there. Then step back from it until a block is at or below it.
 */
export async function resolveStartBlock(opts: ResolveStartBlockOptions): Promise<bigint> {
  const { client, maxBlockRange } = opts;
  const log = opts.log ?? createLogger('atlatl:start-block-resolver');

  const head = await client.getBlockNumber();
  const [floorTs, { timestamp: headTs }] = await Promise.all([
    oldestRelevantCaptureTimestamp(opts.rollup, opts.roundaboutSize, head),
    client.getBlock({ blockNumber: head }),
  ]);

  const slotDuration = BigInt(opts.ethereumSlotDuration);
  const slotsSinceFloor = (maxBigint(headTs - floorTs, 0n) + slotDuration - 1n) / slotDuration;
  let block = maxBigint(head - slotsSinceFloor, 0n);
  while (block > 0n && (await client.getBlock({ blockNumber: block })).timestamp > floorTs) {
    block = maxBigint(block - maxBlockRange, 0n);
  }

  log.debug(`Scanning first-prover captures from L1 block ${block} (head ${head})`);
  return block;
}

/**
 * The earliest L1 timestamp at which a FirstProverRecorded event can still matter, read exactly from the rollup.
 *
 * The rollup keeps checkpoint `n`'s log readable while `n <= pending && pending < n + roundaboutSize` (the STFLib
 * gate), and every claim reads one. So the oldest checkpoint a claim can still be built on is
 * `pending - roundaboutSize + 1`, and it is readable by construction. Both reads pin to `atBlock`, so the pending
 * tip and the log come from one state and the gate cannot revert between them.
 *
 * The result is the start of that checkpoint's epoch, not its own slot: a capture below the claimable ones can
 * still set a range boundary when it shares an epoch with them, and such a capture can land as early as the
 * epoch's first slot.
 *
 * A young chain needs no special path: while `pending < roundaboutSize` the oldest readable checkpoint clamps to
 * the genesis checkpoint 0 at slot 0, so the floor is the rollup's genesis time.
 */
async function oldestRelevantCaptureTimestamp(
  rollup: RollupContract,
  roundaboutSize: number,
  atBlock: bigint,
): Promise<bigint> {
  const [pending, epochDuration] = await Promise.all([
    rollup.getCheckpointNumber({ blockNumber: atBlock }),
    rollup.getEpochDuration(),
  ]);
  const oldest = CheckpointNumber(Math.max(0, pending - roundaboutSize + 1));
  const { slotNumber } = await rollup.getCheckpoint(oldest, { blockNumber: atBlock });
  const epoch = await rollup.getEpochNumberForSlotNumber(slotNumber);
  // The rollup aligns epochs to slot multiples of epochDuration, so the epoch's first slot is this product.
  const epochStartSlot = SlotNumber(Number(epoch) * epochDuration);
  return rollup.getTimestampForSlot(epochStartSlot);
}
