import type { GasPrice, L1BlobInputs, L1TxConfig, L1TxRequest, TxUtilsState } from '@aztec/ethereum/l1-tx-utils';

import type { SentL1Tx } from './relayer_l1_tx_utils.js';

/** Identifies the relayer flow that produced an L1 submission. */
export enum L1SubmissionType {
  Withdrawal = 'withdrawal',
  L1Operation = 'l1-operation',
  ProverClaim = 'prover-claim',
  FpcFunding = 'fpc-funding',
}

/** The send methods available while an application submission batch is open. */
export interface L1SubmissionBatchSender {
  sendTransaction(
    request: L1TxRequest,
    gasConfigOverrides?: L1TxConfig,
    blobInputs?: L1BlobInputs,
    stateChange?: TxUtilsState,
  ): Promise<SentL1Tx>;

  sendTransactionWithGasPrice(
    request: L1TxRequest,
    gasConfigOverrides: L1TxConfig | undefined,
    gasPrice: GasPrice,
  ): Promise<SentL1Tx>;
}

/** Work that prepares and broadcasts transactions when its application batch opens. */
export interface L1Submission<T> {
  kind: L1SubmissionType;
  /** True only when fresh validation shows that work dropped from an earlier window is still valid. */
  retry?: boolean;
  submit(sender: L1SubmissionBatchSender): Promise<T>;
}

/** Application-level admission policy layered over the nonce-safe L1 transaction utility. */
export interface L1SubmissionBatcher {
  enqueue<T>(submission: L1Submission<T>): Promise<T>;
}

/** Uses application batching when the host supplies it, while keeping Atlatl usable standalone. */
export function enqueueL1Submission<T>(
  batcher: L1SubmissionBatcher | undefined,
  fallbackSender: L1SubmissionBatchSender,
  submission: L1Submission<T>,
): Promise<T> {
  return batcher ? batcher.enqueue(submission) : submission.submit(fallbackSender);
}
