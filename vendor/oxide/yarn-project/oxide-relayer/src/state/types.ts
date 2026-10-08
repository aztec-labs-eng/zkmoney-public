import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { EthAddress } from '@aztec/foundation/eth-address';

import type { L1OperationCondition, L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';

import type { Hex } from 'viem';

/** Stable `LogCursor.source` keys for each watched log stream. */
export const LogCursorSources = {
  l1OperationBroadcaster: 'l1OperationBroadcaster',
  l1OperationTransferDiscovery: 'l1OperationTransferDiscovery',
} as const;
export type LogCursorSource = (typeof LogCursorSources)[keyof typeof LogCursorSources];

/** Last observed reason an L1 operation stayed pending after a retry check. */
export const PENDING_L1_OPERATION_REASONS = [
  'unprofitable',
  'simulation_reverted',
  'screening_error',
  'completion_error',
] as const;
export type PendingL1OperationReason = (typeof PENDING_L1_OPERATION_REASONS)[number];

export const L1_OPERATION_STATUSES = ['waiting', 'pending', 'executed', 'dropped', 'blocked'] as const;
export type L1OperationStatus = (typeof L1_OPERATION_STATUSES)[number];

export interface BaseLogCursor {
  source: LogCursorSource;
  blockNumber: bigint;
  updatedAt?: Date;
  lastPolledAt?: Date;
}

export interface L1LogCursor extends BaseLogCursor {
  address: EthAddress;
  blockHash?: Hex;
}

export interface L2LogCursor extends BaseLogCursor {
  address: AztecAddress;
}

export interface PendingL1Operation {
  operationId: Hex;
  broadcaster: AztecAddress;
  l2TxHash: string;
  l2BlockNumber: bigint;
  /** Hash of the L2 block the broadcast tx was last seen in; re-read when the proven tip passes the block. */
  l2BlockHash?: string;
  target: EthAddress;
  payoutToken: EthAddress;
  calldata: Buffer;
  /** The broadcaster-chosen condition that must fire before the operation leaves `waiting`. */
  condition: L1OperationCondition;
  status: L1OperationStatus;
  /** Consecutive failed executor simulations. */
  attempts: number;
  lastCheckedAt?: Date;
  nextCheckAt?: Date;
  /** When a waiting Balance operation's one-time `balanceOf` read ran; a set value stops it being read again. */
  lastBalanceCheckAt?: Date;
  lastReason?: PendingL1OperationReason;
  createdAt: Date;
  updatedAt?: Date;
}

/** One waiting Balance operation and the `(token, recipient)` pair its condition names. */
export interface WaitingBalanceOperation {
  operationId: Hex;
  token: EthAddress;
  recipient: EthAddress;
}

export interface PendingL1OperationRetry {
  lastCheckedAt?: Date;
  nextCheckAt?: Date;
  lastReason?: PendingL1OperationReason;
  incrementAttempts?: boolean;
}

export interface PendingL1OperationFilter {
  dueAt?: Date;
  limit?: number;
}

/** Deployment-env manifest Oxide deployment coordinates persisted with relayer state. */
export interface RelayerDeployment {
  chainId: bigint;
  portal: string;
  l2Token: string;
  rollupVersion: bigint;
  broadcaster?: string;
}

/**
 * Relayer operational state.
 */
export interface StateStore {
  upsertL1Cursor(cursor: L1LogCursor): Promise<void>;
  getL1Cursor(key: Pick<L1LogCursor, 'source' | 'address'>): Promise<L1LogCursor | undefined>;
  deleteL1Cursor(key: Pick<L1LogCursor, 'source' | 'address'>): Promise<void>;
  upsertL2Cursor(cursor: L2LogCursor): Promise<void>;
  getL2Cursor(key: Pick<L2LogCursor, 'source' | 'address'>): Promise<L2LogCursor | undefined>;
  upsertPendingL1Operation(...operations: PendingL1Operation[]): Promise<void>;
  getPendingL1Operation(operationId: Hex): Promise<PendingL1Operation | undefined>;
  /** The L2 block the operations of this broadcast tx are recorded at, or undefined if the tx is unknown. */
  l2BlockForL2Tx(broadcaster: AztecAddress, l2TxHash: string): Promise<bigint | undefined>;
  /** Re-anchors every operation of a broadcast tx that was pruned and re-included in a different block. */
  setL1OperationL2Block(broadcaster: AztecAddress, l2TxHash: string, block: bigint, hash?: string): Promise<void>;
  /** Only `pending` rows; a `waiting` operation is never handed to the submitter. */
  listPendingL1Operations(filter?: PendingL1OperationFilter): Promise<PendingL1Operation[]>;
  /** Waiting operations of one condition kind, oldest first. */
  listWaitingL1Operations(kind: L1OperationConditionKind, limit?: number): Promise<PendingL1Operation[]>;
  /** Waiting Balance operations whose condition names `token` and one of `recipients`; one indexed lookup. */
  findWaitingBalanceOperations(token: EthAddress, recipients: EthAddress[]): Promise<WaitingBalanceOperation[]>;
  /** Waiting Balance operations whose one-time `balanceOf` read has not run yet, oldest first. */
  listUncheckedBalanceOperations(limit: number): Promise<WaitingBalanceOperation[]>;
  markL1OperationBalanceChecked(operationId: Hex): Promise<void>;
  /** `waiting` → `dropped` for each operation of one condition kind recorded before `createdBefore`. Returns the count. */
  dropWaitingL1Operations(kind: L1OperationConditionKind, createdBefore: Date): Promise<number>;
  /** `waiting` → `pending`, due immediately. False when the operation is not waiting. */
  markL1OperationPending(operationId: Hex): Promise<boolean>;
  updatePendingL1OperationRetry(operationId: Hex, retry: PendingL1OperationRetry): Promise<boolean>;
  setL1OperationStatus(operationId: Hex, status: L1OperationStatus): Promise<boolean>;
}
