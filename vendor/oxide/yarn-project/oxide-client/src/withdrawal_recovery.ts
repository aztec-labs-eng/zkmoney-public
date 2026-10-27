import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { PrivateEvent, PrivateEventFilter, Wallet } from '@aztec-labs/aztec.js/wallet';
import type { EventMetadataDefinition } from '@aztec-labs/stdlib/abi';
import type { TxHash } from '@aztec-labs/stdlib/tx';

import type { PortalDomain } from '@oxide/oxide-lib/types.js';
import { type WithdrawalRecoveryData, assembleRecoveryData } from '@oxide/oxide-lib/withdrawal_recovery_data.js';

import type { ChainDataSource } from './chain_data_source.js';
import { type VerifiedWithdrawalInTx, verifyWithdrawalInTx } from './withdrawal_in_tx.js';

export interface WithdrawalRecoveryFailure {
  txHash: TxHash;
  reason: string;
}

/**
 * A withdrawal from its recovery data. Its finalization data matches a withdrawal message that the tx attested and
 * sent. Its memo has nothing to match: the token emits it as the tx sender gave it.
 */
export type RecoveredWithdrawal = VerifiedWithdrawalInTx & Pick<WithdrawalRecoveryData, 'memo'>;

export interface WithdrawalRecoveryResult {
  /** The withdrawals that the recovery data gives, each verified against its transaction. */
  withdrawals: RecoveredWithdrawal[];
  /** Transactions whose recovery data could not be reconstructed or did not match the transaction. */
  failures: WithdrawalRecoveryFailure[];
}

type WithdrawalRecoveryChunkEvent = PrivateEvent<{ fields: bigint[] }>;

/**
 * Discover the owner's withdrawals from the `WithdrawalRecoveryChunk` events of `portal.l2Token`. Register the
 * token contract with the wallet, store its immutables, and let the wallet sync first. Each transaction's events are
 * read as one ordered group, so a repeated read replaces the group instead of adding to it. Continuation events extend
 * the data of one withdrawal; they are not withdrawals of their own.
 */
export async function recoverWithdrawals(args: {
  wallet: Pick<Wallet, 'getPrivateEvents'>;
  chain: Pick<ChainDataSource, 'getTxEffect'>;
  portal: PortalDomain;
  owner: AztecAddress;
  /** The `WithdrawalRecoveryChunk` event metadata of the caller's OxideToken bindings. */
  recoveryEventMetadata: EventMetadataDefinition;
  filter?: Pick<PrivateEventFilter, 'fromBlock' | 'toBlock' | 'txHash'>;
}): Promise<WithdrawalRecoveryResult> {
  const events = await args.wallet.getPrivateEvents<{ fields: bigint[] }>(args.recoveryEventMetadata, {
    ...args.filter,
    contractAddress: args.portal.l2Token,
    scopes: [args.owner],
  });

  const result: WithdrawalRecoveryResult = { withdrawals: [], failures: [] };
  for (const [txHash, group] of groupByTx(events)) {
    try {
      result.withdrawals.push(...(await recoverWithdrawalsInTx(args, txHash, group)));
    } catch (error) {
      result.failures.push({ txHash, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/**
 * One transaction's withdrawals, in event order. Repeated recovery data of one withdrawal gives it once. Throws when
 * any withdrawal of the transaction does not verify.
 */
async function recoverWithdrawalsInTx(
  args: { chain: Pick<ChainDataSource, 'getTxEffect'>; portal: PortalDomain },
  txHash: TxHash,
  events: WithdrawalRecoveryChunkEvent[],
): Promise<RecoveredWithdrawal[]> {
  const assembled = assembleRecoveryData(events.map(({ event }) => event.fields.map(value => new Fr(value))));
  const effect = (await args.chain.getTxEffect(txHash))?.data;
  if (!effect) {
    throw new Error(`Tx effect not found for hash ${txHash}`);
  }
  const recovered: RecoveredWithdrawal[] = [];
  for (const { finalizationData, memo } of assembled) {
    const withdrawal = { txHash, finalizationData };
    const message = await verifyWithdrawalInTx(args.chain, args.portal, withdrawal, effect);
    if (recovered.some(other => other.withdrawalIndex === message.withdrawalIndex)) {
      continue;
    }
    recovered.push({ ...withdrawal, ...message, memo });
  }
  return recovered;
}

/** Keeps the PXE's order: by block, by transaction, then by event position in the transaction. */
function groupByTx(events: WithdrawalRecoveryChunkEvent[]): Array<[TxHash, WithdrawalRecoveryChunkEvent[]]> {
  const groups = new Map<string, [TxHash, WithdrawalRecoveryChunkEvent[]]>();
  for (const event of events) {
    const key = event.metadata.txHash.toString();
    const group = groups.get(key) ?? [event.metadata.txHash, []];
    group[1].push(event);
    groups.set(key, group);
  }
  return [...groups.values()];
}
