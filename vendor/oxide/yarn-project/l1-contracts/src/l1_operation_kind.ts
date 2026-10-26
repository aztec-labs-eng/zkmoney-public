import { type BroadcastL1Operation, L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { type Abi, type Hex, getAbiItem, parseAbi, toFunctionSelector } from 'viem';

import {
  AcrossBridgeEscrowFactoryAbi,
  CCTPBridgeEscrowFactoryAbi,
  OxidePortalAbi,
  SwapEscrowFactoryAbi,
} from './artifacts.js';
import { decodeSipaSweepOperation, decodeSubsidizedDeployAndSweep } from './sipa_sweep_operation.js';
import { LegacySwapEscrowFactoryAbi } from './swap_on_withdraw.js';

export type L1OperationKind = 'withdrawal_finalization' | 'refund' | 'sweep' | 'swap' | 'bridge' | 'other';

function selectors(abi: Abi, names: string[]): Set<Hex> {
  return new Set(names.map(name => toFunctionSelector(getAbiItem({ abi, name }) as never)));
}

/**
 * The single-deposit refund of a portal from before batched frozen deposit refunds, and the error it reverts with on a
 * bad proof. A relayer still relays it from such a frozen portal during a migration.
 */
export const LegacyFrozenDepositRefundAbi = parseAbi([
  'struct RefundFrozenDepositArgs { address executor; bytes userPayload; bytes relayerPayload; uint256 amount; bytes32 siloedNullifier; bytes proof; bytes teeSignature; }',
  'function refundFrozenDeposit(RefundFrozenDepositArgs _args)',
  'error OxidePortal__InvalidFrozenDepositRefundProof()',
]);

const REFUND_SELECTORS = new Set([
  ...selectors(OxidePortalAbi, ['refundFrozenNotes', 'refundFrozenDeposits', 'refundUnprocessedDeposit']),
  ...selectors(LegacyFrozenDepositRefundAbi, ['refundFrozenDeposit']),
]);
/** The escrow factories whose `deployAndExecute` calls classify as `swap`. */
export const SWAP_ESCROW_FACTORY_ABIS: Abi[] = [SwapEscrowFactoryAbi, LegacySwapEscrowFactoryAbi];
/** The escrow factories whose `deployAndExecute` calls classify as `bridge`. */
export const BRIDGE_ESCROW_FACTORY_ABIS: Abi[] = [CCTPBridgeEscrowFactoryAbi, AcrossBridgeEscrowFactoryAbi];

const SWAP_SELECTORS = new Set(SWAP_ESCROW_FACTORY_ABIS.flatMap(abi => [...selectors(abi, ['deployAndExecute'])]));
const BRIDGE_SELECTORS = new Set(BRIDGE_ESCROW_FACTORY_ABIS.flatMap(abi => [...selectors(abi, ['deployAndExecute'])]));

/** The kind of a broadcast L1 operation, from its condition and calldata only. */
export function classifyL1Operation(operation: BroadcastL1Operation): L1OperationKind {
  if (operation.condition.kind === L1OperationConditionKind.MessageInOutbox) {
    return 'withdrawal_finalization';
  }
  if (decodeSubsidizedDeployAndSweep(operation) !== undefined || decodeSipaSweepOperation(operation) !== undefined) {
    return 'sweep';
  }
  const selector = `0x${operation.calldata.subarray(0, 4).toString('hex')}` as Hex;
  if (REFUND_SELECTORS.has(selector)) {
    return 'refund';
  }
  if (SWAP_SELECTORS.has(selector)) {
    return 'swap';
  }
  if (BRIDGE_SELECTORS.has(selector)) {
    return 'bridge';
  }
  return 'other';
}
