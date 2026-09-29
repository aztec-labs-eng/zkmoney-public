import { BlockNumber, CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { TxHash } from '@aztec/stdlib/tx';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { DiscoveredClaim } from '../prover_claim_lib/index.js';
import { CapturedRange } from './first_prover_tracker.js';
import { ProverClaimBacklog } from './prover_claim_backlog.js';
import { ProverClaimIngester } from './prover_claim_ingester.js';

// roundaboutSize = epochDuration(4) * (proofSubmissionEpochs(1) + 1) + 1 = 9.
const ROUNDABOUT_SIZE = 9;

const discovered = (withdrawalIndex: number): DiscoveredClaim => ({
  portalId: 'portal-a',
  checkpointNumber: CheckpointNumber(10),
  rewardContext: {
    epochNumber: EpochNumber(1),
    messageLeafIndex: BigInt(withdrawalIndex),
    pathLength: 7n,
    tip: 10n,
  },
  txRef: {
    epochNumber: EpochNumber(1),
    checkpointNumber: CheckpointNumber(10),
    blockNumber: BlockNumber(10),
    txHash: TxHash.random(),
  },
  withdrawalIndex,
  leafId: BigInt(128 + withdrawalIndex),
});

const range = (epochStart: number, length: number, rangeStart = epochStart): CapturedRange => ({
  epoch: EpochNumber(1),
  rangeStartCheckpoint: CheckpointNumber(rangeStart),
  epochCheckpoints: Array.from({ length }, (_, i) => ({ number: CheckpointNumber(epochStart + i) })) as any,
});

describe('ProverClaimIngester', () => {
  let backlog: ProverClaimBacklog;
  let discover: jest.Mock<(...args: any[]) => Promise<DiscoveredClaim[]>>;

  const build = (overrides: Partial<ConstructorParameters<typeof ProverClaimIngester>[0]> = {}) =>
    new ProverClaimIngester({
      discoverer: { discover: (...args: any[]) => discover(...args) } as any,
      backlog,
      roundaboutSize: ROUNDABOUT_SIZE,
      ...overrides,
    });

  beforeEach(() => {
    backlog = new ProverClaimBacklog();
    discover = jest.fn(() => Promise.resolve([discovered(0)]));
  });

  it('deadlines a claim at the last pending tip that still keeps the epoch boundary readable', async () => {
    // Epoch starts at 10, so `assertFirstCheckpointInEpoch` reads checkpoint 9, which the rollup keeps while
    // pending < 9 + 9 = 18.
    await build().onRange(range(10, 3));

    const [claim] = backlog.getPortalClaims('portal-a');
    expect(claim.deadlinePending).toBe(17);
  });

  it('gives a genesis epoch one more checkpoint, since it has no predecessor to read', async () => {
    // At the genesis checkpoint the predecessor read is skipped, so the oldest log read is checkpoint 1 itself.
    await build().onRange(range(1, 3));

    const [claim] = backlog.getPortalClaims('portal-a');
    expect(claim.deadlinePending).toBe(9);
  });

  it('records the captured proof length, which every claim in the range verifies against', async () => {
    await build().onRange(range(10, 4));

    const [claim] = backlog.getPortalClaims('portal-a');
    expect(claim.proofLength).toBe(4n);
  });

  it('discovers only the checkpoints at or above the range start, against the whole epoch', async () => {
    await build().onRange(range(10, 4, 12));

    const [, newCheckpoints, epochCheckpoints] = discover.mock.calls[0];
    expect((newCheckpoints as any[]).map(c => c.number)).toEqual([12, 13]);
    expect((epochCheckpoints as any[]).map(c => c.number)).toEqual([10, 11, 12, 13]);
  });

  it('backlogs nothing for a range that discovered no claims', async () => {
    discover.mockResolvedValue([]);

    await build().onRange(range(10, 3));

    expect(backlog.getPortalClaims('portal-a')).toHaveLength(0);
  });
});
