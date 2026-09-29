import { CheckpointNumber } from '@aztec/foundation/branded-types';

import { ProverClaim } from '@oxide/l1-contracts/oxide_portal.js';

import { DiscoveredClaim } from '../prover_claim_lib/index.js';

export interface PendingProverClaim {
  /** `${portalId}:${txHash}:${withdrawalIndex}`, stable across re-assembly. */
  id: string;
  portalId: string;
  claim: DiscoveredClaim;
  /** Length of the proof this claim verifies against; fixed when the range was captured. */
  proofLength: bigint;
  /**
   * Highest pending checkpoint at which this claim can still be submitted. Past it the rollup has overwritten
   * the checkpoint log that `ProverClaimLib` reads, and the claim reverts for good.
   */
  deadlinePending: CheckpointNumber;
  status: 'pending' | 'publishing';
  /** Assembled lazily; re-built just before publishing, since assembly re-checks the portal freeze. */
  assembled?: ProverClaim;
}

export function claimId(claim: DiscoveredClaim): string {
  // A withdrawal can only be prover-claimed once, so one entry per (portal, tx, withdrawal).
  return `${claim.portalId}:${claim.txRef.txHash}:${claim.withdrawalIndex}`;
}

/**
 * The claims discovered but not yet submitted. `ProverClaimIngester` adds them; `ProfitableClaimBatchSubmitter` drains
 * them on its own schedule.
 *
 * In memory on purpose: a claim outlives at most one checkpoint-log window (~1 hour), and the tracker replays
 * that whole window on every start. Losing the backlog on restart therefore costs a re-discovery, not a tip.
 */
export class ProverClaimBacklog {
  private readonly claims = new Map<string, PendingProverClaim>();

  /**
   * Add the claims discovered in one captured range. A claim already present is left as it is, so a replayed
   * range costs nothing.
   */
  add(claims: Omit<PendingProverClaim, 'status'>[]): void {
    for (const claim of claims) {
      if (!this.claims.has(claim.id)) {
        this.claims.set(claim.id, { ...claim, status: 'pending' });
      }
    }
  }

  /** Every claim for a portal, in no particular order. */
  getPortalClaims(portalId: string): PendingProverClaim[] {
    return [...this.claims.values()].filter(claim => claim.portalId === portalId).map(claim => ({ ...claim }));
  }

  /** True while a batch for this portal is in flight. */
  isPublishing(portalId: string): boolean {
    return [...this.claims.values()].some(claim => claim.portalId === portalId && claim.status === 'publishing');
  }

  /** Write back mutated fields (status, assembled). Claims already resolved are skipped. */
  update(claims: PendingProverClaim[]): void {
    for (const claim of claims) {
      if (this.claims.has(claim.id)) {
        this.claims.set(claim.id, { ...claim });
      }
    }
  }

  /** Remove claims from the backlog. Idempotent: an id that is already gone is skipped. */
  resolve(ids: string[]): void {
    for (const id of ids) {
      this.claims.delete(id);
    }
  }
}
