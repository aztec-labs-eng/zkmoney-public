import type { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { type EventCursor, getPublicEvents } from '@aztec/aztec.js/events';
import type { AztecNode } from '@aztec/aztec.js/node';
import { BlockNumber } from '@aztec/foundation/branded-types';
import { type Logger, createLogger } from '@aztec/foundation/log';
import type { FunctionSelector } from '@aztec/stdlib/abi';
import type { TxHash } from '@aztec/stdlib/tx';

import { BroadcasterContract } from '@oxide/noir-contracts.js/Broadcaster';
import {
  L1OperationConditionKind,
  computeL1OperationId,
  extractL1Operations,
  l1OperationEventSelector,
} from '@oxide/oxide-lib/l1_operation_calldata.js';
import { addressKey } from '@oxide/watcher-lib/address-key';

import type { RelayerTelemetry } from '../relayer_telemetry.js';
import {
  type L1OperationStatus,
  type L2LogCursor,
  LogCursorSources,
  type PendingL1Operation,
  type StateStore,
} from '../state/types.js';
import type { BalanceWatcher, OutboxWatcher } from './l1_operation_condition.js';

/** Per-poll counts: operations first seen on L2, and waiting operations whose condition fired. */
export interface L1OperationSyncSummary {
  discovered: number;
  markedPending: number;
}

export interface L1OperationSyncerDeps {
  node: AztecNode;
  store: StateStore;
  broadcaster: AztecAddress;
  payoutToken: EthAddress;
  supportedTokens: EthAddress[];
  /** Marks waiting `Balance` operations pending. Undefined leaves them waiting forever. */
  balanceWatcher?: BalanceWatcher;
  /** Marks waiting `MessageInOutbox` operations pending. */
  outboxWatcher?: OutboxWatcher;
  telemetry?: RelayerTelemetry;
  logger?: Logger;
}

/**
 * Reads `L1Operation` public logs into the `pending_l1_operations` table. The log is only a signal: the payload
 * lives in the broadcast tx's public call arguments, which the node holds until the tx finalizes, so the syncer
 * scans through the *pending* L2 head. The cursor only commits to the proven tip; the unproven window is re-scanned
 * every poll.
 */
export class L1OperationSyncer {
  private readonly log: Logger;
  private selector?: FunctionSelector;

  constructor(private readonly deps: L1OperationSyncerDeps) {
    this.log = deps.logger ?? createLogger('oxide-relayer:l1-operation-syncer');
  }

  async runOnce(): Promise<L1OperationSyncSummary> {
    const head = await this.deps.node.getBlockNumber();
    const provenBlock = await this.deps.node.getBlockNumber('proven');
    const cursor = await this.deps.store.getL2Cursor(this.cursorKey());
    // A fresh store bootstraps at the proven tip: older payloads are pruned, so a historical scan could
    // only log unrecoverable-payload warnings.
    const lastProcessed = cursor ? Number(cursor.blockNumber) : Math.min(provenBlock, head);
    const fromBlock = Math.max(lastProcessed + 1, 1);

    if (head < fromBlock) {
      await this.advanceCursor(BigInt(lastProcessed));
      return { discovered: 0, markedPending: await this.runWatchers() };
    }

    let discovered = 0;
    const processedTxs = new Set<string>();
    let afterEvent: EventCursor | undefined;
    do {
      const { events, nextCursor } = await getPublicEvents(this.deps.node, BroadcasterContract.events.L1Operation, {
        contractAddress: this.deps.broadcaster,
        fromBlock: BlockNumber(fromBlock),
        toBlock: BlockNumber(head + 1),
        afterEvent,
      });
      for (const event of events) {
        const txHash = event.metadata.txHash;
        if (!txHash || processedTxs.has(txHash.toString())) {
          continue;
        }
        processedTxs.add(txHash.toString());
        discovered += await this.processTx(txHash, BigInt(event.metadata.l2BlockNumber));
      }
      afterEvent = nextCursor;
    } while (afterEvent);

    // Clamp to head: `provenBlock` is fetched after `head` and can overtake it (chain progressed between the two
    // calls, or a load balancer routed them to differently-synced nodes). Logs were only fetched through `head`, so
    // committing past it would permanently skip the blocks in between.
    await this.advanceCursor(BigInt(Math.min(provenBlock, head)));
    return { discovered, markedPending: await this.runWatchers() };
  }

  private async runWatchers(): Promise<number> {
    const byOutbox = (await this.deps.outboxWatcher?.runOnce()) ?? 0;
    const byBalance = (await this.deps.balanceWatcher?.runOnce()) ?? 0;
    return byOutbox + byBalance;
  }

  /** Fetch the broadcast tx and persist every operation it carries. */
  private async processTx(txHash: TxHash, l2BlockNumber: bigint): Promise<number> {
    const l2TxHash = txHash.toString();
    const known = await this.deps.store.l2BlockForL2Tx(this.deps.broadcaster, l2TxHash);
    if (known !== undefined) {
      // A pruned and re-included broadcast comes back under the same tx hash in a new block. Its operations are
      // already stored; only where they are anchored changed.
      if (known !== l2BlockNumber) {
        await this.deps.store.setL1OperationL2Block(this.deps.broadcaster, l2TxHash, l2BlockNumber);
        this.log.info('Broadcast tx re-included in another L2 block; re-anchoring its operations', {
          event: 'l1_operation_reanchored',
          l2TxHash,
          from: known.toString(),
          to: l2BlockNumber.toString(),
        });
      }
      return 0;
    }

    const tx = await this.deps.node.getTxByHash(txHash);
    if (!tx) {
      this.log.warn('Broadcast tx no longer held by the node; L1 operation payload is unrecoverable', {
        event: 'l1_operation_tx_unavailable',
        l2TxHash,
        l2BlockNumber: l2BlockNumber.toString(),
      });
      return 0;
    }

    const operations = extractL1Operations(tx, await this.eventSelector());
    if (operations.length === 0) {
      this.log.warn('L1Operation log without decodable public call arguments', {
        event: 'l1_operation_undecodable',
        l2TxHash,
        l2BlockNumber: l2BlockNumber.toString(),
      });
      return 0;
    }

    const pending: PendingL1Operation[] = [];
    for (const operation of operations) {
      const operationId = computeL1OperationId(operation, txHash);
      // The broadcaster chooses the payout token, and a token it controls can report any payout.
      if (!operation.payoutToken.equals(this.deps.payoutToken)) {
        this.log.debug('Skipping L1 operation that pays out in a token this relayer does not accept', {
          operationId,
          payoutToken: operation.payoutToken.toString().toLowerCase(),
          l2TxHash,
        });
        continue;
      }
      if (
        operation.condition.kind === L1OperationConditionKind.Balance &&
        !this.watchesToken(operation.condition.token)
      ) {
        this.log.debug('Skipping L1 operation that waits on a token this relayer does not watch', {
          operationId,
          token: operation.condition.token.toString().toLowerCase(),
          l2TxHash,
        });
        continue;
      }
      const status: L1OperationStatus =
        operation.condition.kind === L1OperationConditionKind.Immediate ? 'pending' : 'waiting';
      pending.push({
        operationId,
        broadcaster: this.deps.broadcaster,
        l2TxHash,
        l2BlockNumber,
        target: operation.target,
        payoutToken: operation.payoutToken,
        calldata: operation.calldata,
        condition: operation.condition,
        status,
        attempts: 0,
      });
    }
    await this.deps.store.upsertPendingL1Operation(...pending);
    for (const operation of pending) {
      const { operationId, status } = operation;
      this.log.info('Discovered L1 operation from L2 broadcast', {
        event: 'l1_operation_discovered',
        operationId,
        status,
        condition: L1OperationConditionKind[operation.condition.kind],
        target: operation.target.toString().toLowerCase(),
        payoutToken: operation.payoutToken.toString().toLowerCase(),
        calldataBytes: operation.calldata.length,
        l2TxHash,
        l2BlockNumber: l2BlockNumber.toString(),
      });
      if (status === 'waiting') {
        this.deps.telemetry?.l1OperationOutcome('waiting');
      }
    }
    return pending.length;
  }

  private watchesToken(token: EthAddress): boolean {
    const key = addressKey(token);
    return this.deps.supportedTokens.some(watched => addressKey(watched) === key);
  }

  private async eventSelector(): Promise<FunctionSelector> {
    this.selector ??= await l1OperationEventSelector();
    return this.selector;
  }

  private cursorKey(): Pick<L2LogCursor, 'source' | 'address'> {
    return {
      source: LogCursorSources.l1OperationBroadcaster,
      address: this.deps.broadcaster,
    };
  }

  private async advanceCursor(blockNumber: bigint): Promise<void> {
    await this.deps.store.upsertL2Cursor({ ...this.cursorKey(), blockNumber, lastPolledAt: new Date() });
  }
}
