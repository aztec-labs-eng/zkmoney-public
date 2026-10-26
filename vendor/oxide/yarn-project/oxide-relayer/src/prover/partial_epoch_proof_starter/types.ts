import { EpochNumber } from '@aztec-labs/foundation/branded-types';
import { Checkpoint } from '@aztec-labs/stdlib/checkpoint';

export interface PartialProofPolicyInput {
  epoch: EpochNumber;
  checkpoints: Checkpoint[];
}

export interface PartialProofDecision {
  submit: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface PartialProofPolicy {
  shouldSubmit(input: PartialProofPolicyInput): Promise<PartialProofDecision>;
  handleReorg?(): void | Promise<void>;
}
