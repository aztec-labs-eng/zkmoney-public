import { BlockNumber, CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { TxEffect, TxHash } from '@aztec/stdlib/tx';

/// EIP-7825 L1 tx cap.
export const L1_TRANSACTION_GAS_CAP = 2n ** 24n;

export interface ObservedTx {
  epochNumber: EpochNumber;
  checkpointNumber: CheckpointNumber;
  blockNumber: BlockNumber;
  txIndexInBlock: number;
  txEffect: TxEffect;
}

export interface TxRef {
  epochNumber: EpochNumber;
  checkpointNumber: CheckpointNumber;
  blockNumber: BlockNumber;
  txHash: TxHash;
}

export function portalId(portal: EthAddress): string {
  return portal.toString().toLowerCase();
}

export interface PortalContext {
  l1Portal: EthAddress;
  l2Portal: AztecAddress;
  token: EthAddress;
}

export interface Binding {
  rollupVersion: Fr;
  chainId: Fr;
  epochDuration: number;
}
