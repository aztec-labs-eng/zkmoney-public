import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import type { FunctionSelector } from '@aztec-labs/stdlib/abi';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client';
import type { TxEffect, TxHash } from '@aztec-labs/stdlib/tx';

import { PermanentError } from '@oxide/oxide-client/errors.js';
import {
  type VerifiedWithdrawalInTx,
  type WithdrawalInTx,
  verifyWithdrawalInTx,
} from '@oxide/oxide-client/withdrawal_in_tx.js';
import {
  L1OperationConditionKind,
  extractL1Operations,
  l1OperationEventSelector,
} from '@oxide/oxide-lib/l1_operation_calldata.js';
import type { PortalDomain } from '@oxide/oxide-lib/types.js';
import { decodeFinalizationData } from '@oxide/oxide-lib/withdrawal_finalization_data.js';

/** Upper bound on the transactions whose requests stay in memory. */
const MAX_CACHED_TXS = 10_000;

/**
 * Reads the finalization requests emitted as an L1 operation that an initiation tx broadcast to relayers and stores
 * them in memory.
 */
export class FinalizationRequestSource {
  private readonly cache = new Map<string, VerifiedWithdrawalInTx[]>();
  private selector?: FunctionSelector;
  private readonly log: Logger;

  constructor(
    private readonly node: Pick<AztecNode, 'getTxByHash' | 'getTxEffect'>,
    private readonly portal: PortalDomain,
    /** The Broadcaster whose calls carry the requests. Calls to other contracts are ignored. */
    private readonly broadcaster: AztecAddress,
    logger?: Logger,
  ) {
    this.log = logger ?? createLogger('oxide-relayer:finalization-request-source');
  }

  /** The verified requests of `txHash`, in withdrawal index order. `effect` saves a node read when the caller has it. */
  async requestsFor(txHash: TxHash, effect?: TxEffect): Promise<VerifiedWithdrawalInTx[]> {
    const key = txHash.toString();
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const tx = await this.node.getTxByHash(txHash);
    if (!tx) {
      // Not cached: a node that has not yet received the tx can still serve it later.
      return [];
    }
    const operations = extractL1Operations(tx, await this.eventSelector(), this.broadcaster);
    const verified: VerifiedWithdrawalInTx[] = [];
    const seen = new Set<number>();
    for (const operation of operations) {
      if (
        operation.condition.kind !== L1OperationConditionKind.MessageInOutbox ||
        !operation.target.equals(this.portal.l1Portal)
      ) {
        continue;
      }
      let withdrawal: WithdrawalInTx;
      try {
        withdrawal = { txHash, finalizationData: decodeFinalizationData(operation.calldata) };
      } catch (error) {
        this.warnDropped(key, error);
        continue;
      }
      try {
        const message = await verifyWithdrawalInTx(this.node, this.portal, withdrawal, effect);
        // The first valid request of a withdrawal wins.
        if (seen.has(message.withdrawalIndex)) {
          continue;
        }
        seen.add(message.withdrawalIndex);
        verified.push({ ...withdrawal, ...message });
      } catch (error) {
        // A missing tx effect is transient; a mismatch is not.
        if (!(error instanceof PermanentError)) {
          throw error;
        }
        this.warnDropped(key, error);
      }
    }
    verified.sort((a, b) => a.withdrawalIndex - b.withdrawalIndex);
    if (verified.length > 0) {
      this.remember(key, verified);
    }
    return verified;
  }

  async request(txHash: TxHash, withdrawalIndex: number): Promise<VerifiedWithdrawalInTx | undefined> {
    return (await this.requestsFor(txHash)).find(request => request.withdrawalIndex === withdrawalIndex);
  }

  private warnDropped(txHash: string, error: unknown): void {
    this.log.warn('Dropping a finalization request that does not decode or match its initiation tx', {
      txHash,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private remember(key: string, requests: VerifiedWithdrawalInTx[]): void {
    if (this.cache.size >= MAX_CACHED_TXS) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, requests);
  }

  private async eventSelector(): Promise<FunctionSelector> {
    this.selector ??= await l1OperationEventSelector();
    return this.selector;
  }
}
