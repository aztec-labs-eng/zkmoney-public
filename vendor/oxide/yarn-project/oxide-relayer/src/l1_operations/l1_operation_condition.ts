import { EthAddress } from '@aztec/aztec.js/addresses';
import { type Logger, createLogger } from '@aztec/foundation/log';

import { TestERC20Abi } from '@oxide/l1-contracts';
import { L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { addressKey } from '@oxide/watcher-lib/address-key';
import type { CursorStore } from '@oxide/watcher-lib/cursor';
import { type TransferEvent, TransferIngester } from '@oxide/watcher-lib/ingester';

import type { PublicClient } from 'viem';

import type { RelayerTelemetry } from '../relayer_telemetry.js';
import { type L1LogCursor, LogCursorSources, type StateStore, type WaitingBalanceOperation } from '../state/types.js';
import type { WithdrawalCompletion } from './withdrawal_completion.js';

export interface BalanceWatcherDeps {
  publicClient: PublicClient;
  store: StateStore;
  /** Tokens whose `Transfer` logs are ingested. The syncer only stores Balance operations naming one of them. */
  tokens: EthAddress[];
  /** Max blocks per `eth_getLogs` call. */
  logWindow: bigint;
  maxReorgDepth?: bigint;
  /** Age from `created_at` after which a waiting operation is dropped. */
  maxAgeMs: number;
  telemetry?: RelayerTelemetry;
  logger?: Logger;
}

/** Checks whether operations conditioned by incoming balance are ready and marks them as such if yes. */
export class BalanceWatcher {
  private readonly log: Logger;

  constructor(private readonly deps: BalanceWatcherDeps) {
    this.log = deps.logger ?? createLogger('oxide-relayer:l1-operation-balance-watcher');
  }

  /** Returns how many waiting operations this poll woke. */
  async runOnce(): Promise<number> {
    await this.#dropExpired();
    const waiting = await this.deps.store.listWaitingL1Operations(L1OperationConditionKind.Balance, 1);
    if (waiting.length === 0) {
      await this.deps.store.deleteL1Cursor(this.#cursorKey());
      return 0;
    }

    const { number: chainTip, hash: chainTipHash } = await this.deps.publicClient.getBlock({ blockTag: 'latest' });
    const cursorStore = this.#cursorStore();
    const hasCursor = (await cursorStore.get()) !== undefined;
    // Without a cursor, no earlier transfer was ingested, so a balance read is necessary for every waiting operation.
    const toCheck = hasCursor
      ? await this.deps.store.listUncheckedBalanceOperations(50)
      : await this.#waitingBalanceOperations();
    const markedByBalance = await this.#readBalances(toCheck, chainTip);
    if (!hasCursor) {
      await cursorStore.set({ block: chainTip, hash: chainTipHash });
    }

    let markedByTransfer = 0;
    const ingester = new TransferIngester({
      publicClient: this.deps.publicClient,
      cursorStore,
      tokens: this.deps.tokens,
      window: this.deps.logWindow,
      maxReorgDepth: this.deps.maxReorgDepth,
      log: this.log,
      onEvents: async events => {
        markedByTransfer += await this.#recordMatches(events);
      },
    });
    await ingester.ingestUpTo(chainTip, chainTipHash);

    return markedByBalance + markedByTransfer;
  }

  async #dropExpired(): Promise<void> {
    const createdBefore = new Date(Date.now() - this.deps.maxAgeMs);
    const dropped = await this.deps.store.dropWaitingL1Operations(L1OperationConditionKind.Balance, createdBefore);
    if (dropped === 0) {
      return;
    }
    for (let i = 0; i < dropped; i++) {
      this.deps.telemetry?.l1OperationOutcome('dropped');
    }
    this.log.warn('Waiting Balance operations dropped after exceeding the max age', {
      event: 'l1_operation_dropped',
      cause: 'waiting_max_age',
      count: dropped,
      createdBefore: createdBefore.toISOString(),
    });
  }

  /** Matches a window's transfer recipients against the waiting Balance rows, one indexed lookup per token. */
  async #recordMatches(events: TransferEvent[]): Promise<number> {
    let markedPending = 0;
    for (const [token, forToken] of groupByToken(events)) {
      // A zero-value transfer funds nothing, so it marks nothing pending; anyone can forge one to any address.
      const funding = forToken.filter(event => event.value > 0n);
      const matched = await this.deps.store.findWaitingBalanceOperations(
        token,
        dedupeAddresses(funding.map(e => e.recipient)),
      );
      if (matched.length === 0) {
        continue;
      }
      // Several operations can wait on one token and recipient, so every match for a recipient is kept.
      const byRecipient = groupByRecipient(matched);
      for (const event of funding) {
        const key = addressKey(event.recipient);
        const operations = byRecipient.get(key);
        if (!operations) {
          continue;
        }
        byRecipient.delete(key);
        for (const operation of operations) {
          markedPending += await this.#markPending(operation, 'transfer', event.block);
        }
      }
    }
    return markedPending;
  }

  async #readBalances(operations: WaitingBalanceOperation[], blockNumber: bigint): Promise<number> {
    let markedPending = 0;
    for (const operation of operations) {
      const balance = await this.#readBalance(operation.token, operation.recipient, blockNumber);
      await this.deps.store.markL1OperationBalanceChecked(operation.operationId);
      if (balance === 0n) {
        continue;
      }
      markedPending += await this.#markPending(operation, 'balance', blockNumber);
    }
    return markedPending;
  }

  async #waitingBalanceOperations(): Promise<WaitingBalanceOperation[]> {
    const waiting = await this.deps.store.listWaitingL1Operations(L1OperationConditionKind.Balance);
    return waiting.map(({ operationId, condition }) => ({
      operationId,
      token: condition.token,
      recipient: condition.recipient,
    }));
  }

  async #markPending(
    operation: WaitingBalanceOperation,
    source: 'balance' | 'transfer',
    block?: bigint,
  ): Promise<number> {
    if (!(await this.deps.store.markL1OperationPending(operation.operationId))) {
      return 0;
    }
    this.log.info('L1 operation condition fired; queueing for execution', {
      event: 'l1_operation_ready',
      condition: 'balance',
      source,
      operationId: operation.operationId,
      token: operation.token.toString().toLowerCase(),
      recipient: operation.recipient.toString().toLowerCase(),
      ...(block === undefined ? {} : { l1Block: Number(block) }),
    });
    return 1;
  }

  #readBalance(token: EthAddress, recipient: EthAddress, blockNumber: bigint): Promise<bigint> {
    return this.deps.publicClient.readContract({
      address: token.toString(),
      abi: TestERC20Abi,
      functionName: 'balanceOf',
      args: [recipient.toString()],
      blockNumber,
    }) as Promise<bigint>;
  }

  #cursorStore(): CursorStore {
    const key = this.#cursorKey();
    return {
      get: async () => {
        const cursor = await this.deps.store.getL1Cursor(key);
        return cursor?.blockHash ? { block: cursor.blockNumber, hash: cursor.blockHash } : undefined;
      },
      set: async ref => {
        await this.deps.store.upsertL1Cursor({
          ...key,
          blockNumber: ref.block,
          blockHash: ref.hash,
          lastPolledAt: new Date(),
        });
      },
    };
  }

  #cursorKey(): Pick<L1LogCursor, 'source' | 'address'> {
    return {
      source: LogCursorSources.l1OperationTransferDiscovery,
      // One cursor spans every watched token, so it is keyed by the zero address rather than a token.
      address: EthAddress.ZERO,
    };
  }
}

export interface OutboxWatcherDeps {
  completion: WithdrawalCompletion;
  store: StateStore;
  telemetry?: RelayerTelemetry;
  logger?: Logger;
}

/** Checks whether operations conditioned by their tx's message reaching the Outbox are ready, and marks them if yes. */
export class OutboxWatcher {
  private readonly log: Logger;

  constructor(private readonly deps: OutboxWatcherDeps) {
    this.log = deps.logger ?? createLogger('oxide-relayer:l1-operation-outbox-watcher');
  }

  /** Returns how many waiting operations this poll woke. */
  async runOnce(): Promise<number> {
    const waiting = await this.deps.store.listWaitingL1Operations(L1OperationConditionKind.MessageInOutbox);
    let markedPending = 0;
    for (const operation of waiting) {
      const status = await this.deps.completion.outboxStatus(operation.l2TxHash);
      if (status === 'unrecoverable') {
        await this.#drop(operation.operationId, operation.l2TxHash);
        continue;
      }
      if (status === 'waiting' || !(await this.deps.store.markL1OperationPending(operation.operationId))) {
        continue;
      }
      markedPending++;
      this.log.info('L1 operation condition fired; queueing for execution', {
        event: 'l1_operation_ready',
        condition: 'messageInOutbox',
        operationId: operation.operationId,
        l2TxHash: operation.l2TxHash,
      });
    }
    return markedPending;
  }

  async #drop(operationId: `0x${string}`, l2TxHash: string): Promise<void> {
    if (!(await this.deps.store.setL1OperationStatus(operationId, 'dropped'))) {
      return;
    }
    this.deps.telemetry?.l1OperationOutcome('dropped');
    this.log.warn('Broadcast tx carries no completable withdrawal; dropping the L1 operation', {
      event: 'l1_operation_dropped',
      cause: 'withdrawal_unrecoverable',
      operationId,
      l2TxHash,
    });
  }
}

/** Groups a window's events by token so each token needs one indexed lookup. */
function groupByToken(events: TransferEvent[]): Array<[EthAddress, TransferEvent[]]> {
  const byKey = new Map<string, { token: EthAddress; events: TransferEvent[] }>();
  for (const event of events) {
    const key = addressKey(event.token);
    const entry = byKey.get(key) ?? { token: event.token, events: [] };
    entry.events.push(event);
    byKey.set(key, entry);
  }
  return [...byKey.values()].map(({ token, events: forToken }) => [token, forToken]);
}

/**
 * Groups the waiting operations by recipient, because nothing prevents one recipient to have multiple operations
 * conditioned by it.
 */
function groupByRecipient(operations: WaitingBalanceOperation[]): Map<string, WaitingBalanceOperation[]> {
  const byKey = new Map<string, WaitingBalanceOperation[]>();
  for (const operation of operations) {
    const key = addressKey(operation.recipient);
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(operation);
    } else {
      byKey.set(key, [operation]);
    }
  }
  return byKey;
}

/** Dedupes by lowercased address string, keeping the first-seen `EthAddress` instance for each. */
function dedupeAddresses(addresses: EthAddress[]): EthAddress[] {
  const byKey = new Map<string, EthAddress>();
  for (const address of addresses) {
    const key = addressKey(address);
    if (!byKey.has(key)) {
      byKey.set(key, address);
    }
  }
  return [...byKey.values()];
}
