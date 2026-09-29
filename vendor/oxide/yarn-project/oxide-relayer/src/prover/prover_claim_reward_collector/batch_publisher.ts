import { Logger, createLogger } from '@aztec/foundation/log';
import { SerialQueue } from '@aztec/foundation/queue';
import { sleep } from '@aztec/foundation/sleep';

import { OxidePortalAbi } from '@oxide/l1-contracts';
import { OxidePortalContract, ProverClaim, toProverTipClaim } from '@oxide/l1-contracts/oxide_portal.js';

import { type Hex, encodeFunctionData } from 'viem';

import {
  type L1SubmissionBatchSender,
  type L1SubmissionBatcher,
  L1SubmissionType,
  enqueueL1Submission,
} from '../../l1_submission_batcher.js';
import type { RelayerL1TxUtils } from '../../relayer_l1_tx_utils.js';
import { ProverPortalConfig } from '../prover_claim_lib/index.js';

const DEFAULT_CONFIRMATION_POLL_INTERVAL_MS = 2_000;

export interface BatchPublisherOptions {
  portal: OxidePortalContract;
  // Must sign with the prover's key: `claimProverTips` credits `msg.sender`, and `ProverClaimLib` requires it
  // to be the address captured in `$firstProver`.
  l1TxUtils: RelayerL1TxUtils;
  l1SubmissionBatcher?: L1SubmissionBatcher;
  // Block depth a claim tx must reach before its `confirmed` promise resolves. 0n confirms at the first mined receipt
  // (dev/e2e).
  confirmations: bigint;
  confirmationPollIntervalMs?: number;
  log?: Logger;
}

type MinedReceipt = { blockNumber: bigint; transactionHash: Hex; status: 'success' | 'reverted' };

export class BatchPublisher {
  private readonly queue = new SerialQueue();
  private readonly log: Logger;
  private stopped = false;
  private retryNextBatch = false;

  constructor(private readonly options: BatchPublisherOptions) {
    this.log = options.log ?? createLogger('atlatl:batch-publisher');
  }

  start(): void {
    this.queue.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.queue.cancel();
  }

  // Resolves once the tx is MINED; submission stays serial so batch N+1 estimates against the state batch N left.
  // The returned `confirmed` resolves once the tx is `confirmations` deep.
  async publish(portal: ProverPortalConfig, claims: ProverClaim[]): Promise<{ confirmed: Promise<void> }> {
    const receipt = await this.queue.put(() => this.submit(portal, claims));
    const confirmed = this.awaitConfirmations(receipt);
    // Keep an unawaited `confirmed` from surfacing as an unhandled rejection; the returned promise still rejects.
    void confirmed.catch(() => {});
    return { confirmed };
  }

  private async submit(portal: ProverPortalConfig, claims: ProverClaim[]): Promise<MinedReceipt> {
    const retry = this.retryNextBatch;
    this.retryNextBatch = false;
    const sent = await enqueueL1Submission(this.options.l1SubmissionBatcher, this.options.l1TxUtils, {
      kind: L1SubmissionType.ProverClaim,
      retry,
      submit: sender => this.prepareAndSubmit(portal, claims, sender),
    });
    const receipt = await sent.settled.catch(error => {
      this.retryNextBatch = true;
      throw error;
    });
    // A revert-protected relay drops a reverting tx; a public mempool (Sepolia, dev) mines it and charges the gas.
    if (receipt.status === 'reverted') {
      throw new Error(`Prover claim tx ${receipt.transactionHash} reverted`);
    }
    return {
      blockNumber: receipt.blockNumber,
      transactionHash: receipt.transactionHash,
      status: receipt.status,
    };
  }

  private async prepareAndSubmit(portal: ProverPortalConfig, claims: ProverClaim[], sender: L1SubmissionBatchSender) {
    const args = [portal.context.proverSubsidy.toString(), claims.map(toProverTipClaim)] as const;

    const contract = this.options.portal.getContract();
    const account = this.options.l1TxUtils.getSenderAddress().toString();

    // Simulate first so a batch that would revert fails before we spend gas.
    await contract.simulate.claimProverTips(args, { account });
    const data: Hex = encodeFunctionData({ abi: OxidePortalAbi, functionName: 'claimProverTips', args });

    this.log.info(`Submitting ${claims.length} prover claim(s) for portal ${portal.context.l1Portal}`);
    return await sender.sendTransaction({
      to: this.options.portal.address.toString(),
      data,
    });
  }

  // Wait until the mined tx is `confirmations` blocks deep, re-checking the receipt each time depth is reached so a
  // reorg that drops or reverts it throws (so the collector retries its batch) and a re-mine into a different block
  // restarts the depth count from there.
  private async awaitConfirmations(receipt: MinedReceipt): Promise<void> {
    if (this.options.confirmations === 0n) {
      return;
    }
    const client = this.options.l1TxUtils.client;
    const pollIntervalMs = this.options.confirmationPollIntervalMs ?? DEFAULT_CONFIRMATION_POLL_INTERVAL_MS;
    while (true) {
      if (this.stopped) {
        throw new Error('BatchPublisher stopped while awaiting confirmations');
      }
      const head = await client.getBlockNumber();
      if (head - receipt.blockNumber + 1n >= this.options.confirmations) {
        const fresh = await client.getTransactionReceipt({ hash: receipt.transactionHash }).catch(() => undefined);
        if (!fresh || fresh.status === 'reverted') {
          throw new Error(`Prover claim tx ${receipt.transactionHash} was reorged out or reverted before confirming`);
        }
        if (fresh.blockNumber === receipt.blockNumber) {
          return;
        }
        receipt = { blockNumber: fresh.blockNumber, transactionHash: fresh.transactionHash, status: fresh.status };
      } else {
        await sleep(pollIntervalMs);
      }
    }
  }
}
