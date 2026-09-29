import { INITIAL_CHECKPOINT_NUMBER } from '@aztec/constants';
import { CheckpointNumber } from '@aztec/foundation/branded-types';
import { Logger, createLogger } from '@aztec/foundation/log';

import { ProverClaimDiscoverer } from '../prover_claim_lib/index.js';
import { CapturedRange } from './first_prover_tracker.js';
import { ProverClaimBacklog, claimId } from './prover_claim_backlog.js';

export interface ProverClaimIngesterOptions {
  discoverer: ProverClaimDiscoverer;
  backlog: ProverClaimBacklog;
  /** `epochDuration * (proofSubmissionEpochs + 1) + 1`; see `#deadlineFor`. */
  roundaboutSize: number;
  log?: Logger;
}

/** Discovers the claims in a captured range and adds them to the backlog for the ProfitableClaimBatchSubmitter. */
export class ProverClaimIngester {
  private readonly log: Logger;

  constructor(private readonly options: ProverClaimIngesterOptions) {
    this.log = options.log ?? createLogger('atlatl:prover-claim-ingester');
  }

  async onRange(range: CapturedRange): Promise<void> {
    const inRangeCheckpoints = range.epochCheckpoints.filter(c => c.number >= range.rangeStartCheckpoint);
    const claims = await this.options.discoverer.discover(range.epoch, inRangeCheckpoints, range.epochCheckpoints);

    // Every claim in a range verifies against the root the captured proof inserted, so they share its length.
    const proofLength = BigInt(range.epochCheckpoints.length);
    const capturedCheckpoint = range.epochCheckpoints[range.epochCheckpoints.length - 1].number;
    const deadlinePending = this.#deadlineFor(range.epochCheckpoints[0].number);
    const rangeId = `${range.epoch}:${range.rangeStartCheckpoint}:${capturedCheckpoint}`;

    this.options.backlog.add(
      claims.map(claim => ({
        id: claimId(claim),
        portalId: claim.portalId,
        claim,
        proofLength,
        deadlinePending,
      })),
    );
    this.log.info(
      `Backlogged ${claims.length} prover claim(s) from ${rangeId}; claimable while the pending tip is at or below ` +
        `${deadlinePending}`,
    );
  }

  #deadlineFor(epochStartCheckpoint: CheckpointNumber): CheckpointNumber {
    const oldestRead =
      epochStartCheckpoint === INITIAL_CHECKPOINT_NUMBER ? epochStartCheckpoint : epochStartCheckpoint - 1;
    return CheckpointNumber(oldestRead + this.options.roundaboutSize - 1);
  }
}
