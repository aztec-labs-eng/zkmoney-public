import { type Logger, createLogger } from '@aztec/foundation/log';
import { sleep } from '@aztec/foundation/sleep';

import type {
  L1Submission,
  L1SubmissionBatchSender,
  L1SubmissionBatcher,
  L1SubmissionType,
} from './l1_submission_batcher.js';
import type { ProtectTxStatus, RelayerL1TxUtils, SentL1Tx } from './relayer_l1_tx_utils.js';

const DEFAULT_STATUS_POLL_INTERVAL_MS = 1_000;

export interface RelayerL1SubmissionBatcherOptions {
  l1TxUtils: RelayerL1TxUtils;
  blockWindow: number;
  statusPollIntervalMs?: number;
  logger?: Logger;
}

interface QueuedSubmission {
  sequence: number;
  kind: L1SubmissionType;
  retry: boolean;
  submit(sender: L1SubmissionBatchSender): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * Coordinates every relayer L1 submission through an application-wide batch.
 *
 * Each batch is a fixed snapshot of queued work. All callbacks in that snapshot can broadcast before the batcher
 * waits for the resulting nonce chain to land or die: through Protect, until the relay reports it terminal or drops
 * it; through a public mempool, until the chain consumes every nonce it sent.
 */
export class RelayerL1SubmissionBatcher implements L1SubmissionBatcher {
  private readonly l1TxUtils: RelayerL1TxUtils;
  private readonly blockWindow: bigint;
  private readonly statusPollIntervalMs: number;
  private readonly log: Logger;
  private readonly queue: QueuedSubmission[] = [];
  private readonly stoppedSignal: Promise<void>;
  private resolveStoppedSignal = () => {};
  private worker: Promise<void> | undefined;
  private nextSequence = 0;
  private resetBeforeNextBatch = false;
  private stopped = false;

  constructor(options: RelayerL1SubmissionBatcherOptions) {
    if (!Number.isInteger(options.blockWindow) || options.blockWindow < 1) {
      throw new Error(`invalid L1 submission block window '${options.blockWindow}'`);
    }
    this.l1TxUtils = options.l1TxUtils;
    this.blockWindow = BigInt(options.blockWindow);
    this.statusPollIntervalMs = options.statusPollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS;
    this.log = options.logger ?? createLogger('oxide-relayer:l1-submission-batcher');
    this.stoppedSignal = new Promise(resolve => {
      this.resolveStoppedSignal = resolve;
    });
  }

  enqueue<T>(submission: L1Submission<T>): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new Error('L1 submission batcher is stopped'));
    }

    const result = new Promise<T>((resolve, reject) => {
      this.queue.push({
        sequence: this.nextSequence++,
        kind: submission.kind,
        retry: submission.retry ?? false,
        submit: sender => submission.submit(sender),
        resolve: value => resolve(value as T),
        reject,
      });
    });
    this.startWorker();
    return result;
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.resolveStoppedSignal();
      this.rejectQueued(new Error('L1 submission batcher stopped before queued work could run'));
    }
    await this.worker;
  }

  private startWorker(): void {
    if (this.worker) {
      return;
    }
    this.worker = this.processQueue()
      .catch(error => {
        this.log.error('L1 submission batch worker failed', {
          event: 'l1_submission_batch_worker_failed',
          error: errMessage(error),
        });
        this.rejectQueued(error);
      })
      .finally(() => {
        this.worker = undefined;
        if (!this.stopped && this.queue.length > 0) {
          this.startWorker();
        }
      });
  }

  private async processQueue(): Promise<void> {
    while (!this.stopped && this.queue.length > 0) {
      // Collect callbacks enqueued in the same turn before closing this batch's fixed snapshot.
      await Promise.resolve();
      const snapshot = this.queue.splice(0);
      snapshot.sort(compareQueuedSubmissions);
      if (this.resetBeforeNextBatch) {
        this.l1TxUtils.resetNonce();
        this.resetBeforeNextBatch = false;
      }

      const sent: SentL1Tx[] = [];
      for (const submission of snapshot) {
        if (this.stopped) {
          submission.reject(new Error('L1 submission batcher stopped before queued work could run'));
          continue;
        }
        try {
          submission.resolve(await submission.submit(this.batchSender(sent)));
        } catch (error) {
          submission.reject(error);
        }
      }

      if (sent.length > 0 && !this.stopped) {
        await this.waitForBatchWindow(sent);
      }
    }
  }

  private batchSender(sent: SentL1Tx[]): L1SubmissionBatchSender {
    const record = (transaction: SentL1Tx): SentL1Tx => {
      sent.push(transaction);
      return transaction;
    };
    return {
      sendTransaction: async (...args) => record(await this.l1TxUtils.sendTransaction(...args)),
      sendTransactionWithGasPrice: async (...args) => record(await this.l1TxUtils.sendTransactionWithGasPrice(...args)),
    };
  }

  /**
   * Holds the next snapshot while a tx in `sent` can still land. Through Protect a tx is dead once the relay reports
   * it terminal or the drop window has passed, and its nonce is free again, so the cached nonce is reset before the
   * next batch. Through a public mempool nothing drops a tx and a local expiry does not kill it, so the hold lasts
   * until the chain consumes every nonce the batch sent; the cached nonce then already points past them.
   */
  private async waitForBatchWindow(sent: SentL1Tx[]): Promise<void> {
    if (!this.l1TxUtils.hasProtectTxStatusEndpoint()) {
      await this.waitForNoncesConsumed(sent);
      return;
    }
    this.resetBeforeNextBatch = true;
    const expiresAfterBlock = (await this.l1TxUtils.client.getBlockNumber()) + 1n + this.blockWindow;
    let reportedStatusError = false;
    let reportedBlockError = false;
    while (!this.stopped) {
      try {
        const statuses = await Promise.all(
          sent.map(transaction => this.l1TxUtils.getProtectTxStatus(transaction.txHash)),
        );
        if (
          statuses.every((status): status is ProtectTxStatus => status !== undefined && isTerminalProtectStatus(status))
        ) {
          return;
        }
      } catch (error) {
        if (!reportedStatusError) {
          reportedStatusError = true;
          this.log.warn('Failed to read Protect transaction status; waiting for the block window', {
            event: 'l1_submission_batch_status_failed',
            error: errMessage(error),
          });
        }
      }
      try {
        if ((await this.l1TxUtils.client.getBlockNumber()) > expiresAfterBlock) {
          return;
        }
      } catch (error) {
        if (!reportedBlockError) {
          reportedBlockError = true;
          this.log.warn('Failed to read the L1 block number while waiting for the submission window', {
            event: 'l1_submission_batch_block_read_failed',
            error: errMessage(error),
          });
        }
      }
      await Promise.race([sleep(this.statusPollIntervalMs), this.stoppedSignal]);
    }
  }

  private async waitForNoncesConsumed(sent: SentL1Tx[]): Promise<void> {
    const address = this.l1TxUtils.getSenderAddress().toString();
    const lastNonce = Math.max(...sent.map(transaction => transaction.state.nonce));
    let reportedNonceError = false;
    while (!this.stopped) {
      try {
        if ((await this.l1TxUtils.client.getTransactionCount({ address, blockTag: 'latest' })) > lastNonce) {
          return;
        }
      } catch (error) {
        if (!reportedNonceError) {
          reportedNonceError = true;
          this.log.warn('Failed to read the L1 nonce while waiting for the batch to land', {
            event: 'l1_submission_batch_nonce_read_failed',
            error: errMessage(error),
          });
        }
      }
      await Promise.race([sleep(this.statusPollIntervalMs), this.stoppedSignal]);
    }
  }

  private rejectQueued(error: Error): void {
    for (const submission of this.queue.splice(0)) {
      submission.reject(error);
    }
  }
}

function compareQueuedSubmissions(left: QueuedSubmission, right: QueuedSubmission): number {
  const rankDelta = submissionRank(left) - submissionRank(right);
  return rankDelta !== 0 ? rankDelta : left.sequence - right.sequence;
}

/** Retries first, so work dropped from an earlier window gets the first nonces; everything else in arrival order. */
function submissionRank(submission: Pick<QueuedSubmission, 'retry'>): number {
  return submission.retry ? 0 : 1;
}

function isTerminalProtectStatus(status: ProtectTxStatus): boolean {
  return (
    status.status === 'INCLUDED' ||
    status.status === 'FAILED' ||
    status.status === 'CANCELLED' ||
    status.isRevert === true ||
    status.simError === 'ExecutionReverted'
  );
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
