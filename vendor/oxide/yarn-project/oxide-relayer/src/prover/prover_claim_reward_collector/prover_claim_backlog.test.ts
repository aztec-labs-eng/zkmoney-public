import { BlockNumber, CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { TxHash } from '@aztec/stdlib/tx';

import { beforeEach, describe, expect, it } from '@jest/globals';

import { DiscoveredClaim } from '../prover_claim_lib/index.js';
import { PendingProverClaim, ProverClaimBacklog, claimId } from './prover_claim_backlog.js';

const PORTAL = 'portal-a';

const discovered = (withdrawalIndex: number, tip = 10n, portal = PORTAL): DiscoveredClaim => ({
  portalId: portal,
  checkpointNumber: CheckpointNumber(5),
  rewardContext: {
    epochNumber: EpochNumber(1),
    messageLeafIndex: BigInt(withdrawalIndex),
    pathLength: 7n,
    tip,
  },
  txRef: {
    epochNumber: EpochNumber(1),
    checkpointNumber: CheckpointNumber(5),
    blockNumber: BlockNumber(5),
    txHash: TxHash.random(),
  },
  withdrawalIndex,
  leafId: BigInt(128 + withdrawalIndex),
});

const entry = (claim: DiscoveredClaim): Omit<PendingProverClaim, 'status'> => ({
  id: claimId(claim),
  portalId: claim.portalId,
  claim,
  proofLength: 3n,
  deadlinePending: CheckpointNumber(100),
});

describe('ProverClaimBacklog', () => {
  let backlog: ProverClaimBacklog;

  beforeEach(() => {
    backlog = new ProverClaimBacklog();
  });

  it('ignores a claim already backlogged, so a replayed range costs nothing', () => {
    const claim = discovered(0);
    backlog.add([entry(claim)]);
    const [backlogged] = backlog.getPortalClaims(PORTAL);
    backlog.update([{ ...backlogged, status: 'publishing' }]);

    // The same claim arrives again from a replayed range; the backlogged one keeps its state.
    backlog.add([entry(claim)]);

    expect(backlog.getPortalClaims(PORTAL)).toHaveLength(1);
    expect(backlog.isPublishing(PORTAL)).toBe(true);
  });

  it('ignores a resolve for a claim that is already gone', () => {
    const claim = discovered(0);
    backlog.add([entry(claim)]);

    backlog.resolve([claimId(claim)]);
    backlog.resolve([claimId(claim)]);

    expect(backlog.getPortalClaims(PORTAL)).toHaveLength(0);
  });

  it('round-trips the publishing flag', () => {
    const claim = discovered(0);
    backlog.add([entry(claim)]);
    expect(backlog.isPublishing(PORTAL)).toBe(false);

    const [pending] = backlog.getPortalClaims(PORTAL);
    backlog.update([{ ...pending, status: 'publishing' }]);
    expect(backlog.isPublishing(PORTAL)).toBe(true);

    backlog.update([{ ...pending, status: 'pending' }]);
    expect(backlog.isPublishing(PORTAL)).toBe(false);
  });

  it('keeps portals separate', () => {
    backlog.add([entry(discovered(0))]);
    backlog.add([entry(discovered(1))]);
    backlog.add([entry(discovered(2, 10n, 'portal-b'))]);

    expect(backlog.getPortalClaims(PORTAL)).toHaveLength(2);
    expect(backlog.getPortalClaims('portal-b')).toHaveLength(1);
  });

  it('drops an update for a claim that already resolved', () => {
    const claim = discovered(0);
    backlog.add([entry(claim)]);
    const [pending] = backlog.getPortalClaims(PORTAL);

    backlog.resolve([claimId(claim)]);
    backlog.update([{ ...pending, status: 'publishing' }]);

    expect(backlog.getPortalClaims(PORTAL)).toHaveLength(0);
  });
});
