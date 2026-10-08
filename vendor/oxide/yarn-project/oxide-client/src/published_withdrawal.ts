import type { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import type { Fr } from '@aztec/aztec.js/fields';
import { MAX_L2_TO_L1_MSGS_PER_TX } from '@aztec/constants';
import type { BlockHash } from '@aztec/stdlib/block';
import type { TxEffect, TxHash } from '@aztec/stdlib/tx';

import { getUserPayloadHash } from '@oxide/oxide-lib/content_hash.js';
import { extractMetadata } from '@oxide/oxide-lib/da_extractors.js';
import { encodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal.js';
import {
  type PublishedWithdrawal,
  WITHDRAWAL_LOG_TAG_INDEX,
  computeSiloedWithdrawalTag,
  decodePublishedWithdrawal,
} from '@oxide/oxide-lib/published_withdrawal.js';

import type { ChainDataSource } from './chain_data_source.js';
import { PermanentError } from './errors.js';

export { type PublishedWithdrawal, computeSiloedWithdrawalTag };

export function extractWithdrawalMessages(effect: TxEffect, siloedTag: Fr): PublishedWithdrawal[] {
  const matches = effect.privateLogs.filter(log => log.fields[WITHDRAWAL_LOG_TAG_INDEX].equals(siloedTag));
  if (matches.length > MAX_L2_TO_L1_MSGS_PER_TX) {
    // More tagged logs than a tx can carry L2-to-L1 messages: malformed by construction.
    throw new PermanentError(
      `Found ${matches.length} withdrawalPublishing logs in tx ${effect.txHash}; max ${MAX_L2_TO_L1_MSGS_PER_TX}`,
    );
  }
  try {
    return matches.map(log => decodePublishedWithdrawal(log.fields));
  } catch (error) {
    // A tagged log with a malformed payload is malformed forever; tx effects are immutable.
    throw new PermanentError(`Failed to decode withdrawalPublishing log in tx ${effect.txHash}: ${error}`);
  }
}

/**
 * Reads the per-withdrawal data emitted by `publish_withdrawal` on L2 (plus the anchor block hash from
 * the TEE metadata DA log). With this, an L1 finalizer needs only the burn tx hash to recover the
 * `(executor, userPayloadHash, amount, proverTip, randomness, signature)` it needs for
 * `OxidePortal.withdraw`. The result is indexed in contract-walk order; callers pick the withdrawal
 * they want to finalize.
 */
export async function fetchPublishedWithdrawals(
  chain: ChainDataSource,
  txHash: TxHash,
  l2Portal: AztecAddress,
): Promise<{ withdrawals: PublishedWithdrawal[]; anchorBlockHash: BlockHash }> {
  const indexedTxEffect = await chain.getTxEffect(txHash);
  if (!indexedTxEffect) {
    throw new Error(`Tx effect not found for hash ${txHash}`);
  }
  const effect = indexedTxEffect.data;

  const withdrawals = extractWithdrawalMessages(effect, await computeSiloedWithdrawalTag(l2Portal));
  let metadata;
  try {
    metadata = await extractMetadata(effect, l2Portal);
  } catch (error) {
    // The metadata DA log is part of the immutable tx effect; failing to decode it can never become valid.
    throw new PermanentError(`Failed to extract metadata from tx ${txHash}: ${error}`);
  }

  return { withdrawals, anchorBlockHash: metadata.anchorBlockHash };
}

// ---------------------------------------------------------------------------------------------
// TEMPORARY: plain-executor user payload recovery
//
// Remove this block with:
// https://linear.app/aztec-labs/issue/OX-1700/solve-user-payload-data-availability
// ---------------------------------------------------------------------------------------------

/**
 * Rebuild the user payload of a published plain-executor withdrawal from its published recipient and relayer tip.
 * The token does not constrain these two values against the committed user payload hash, so this function checks the
 * hash.
 */
export function plainWithdrawalUserPayload(
  withdrawal: PublishedWithdrawal,
  plainWithdrawalExecutor: EthAddress,
  txHash: TxHash,
): Buffer {
  if (!withdrawal.executor.equals(plainWithdrawalExecutor)) {
    throw new PermanentError(`Tx ${txHash} withdraws through unknown executor ${withdrawal.executor}`);
  }
  const userPayload = encodePlainWithdrawalPayload({
    recipient: withdrawal.recipient,
    relayerTip: withdrawal.relayerTip,
  });
  if (!getUserPayloadHash(userPayload).equals(withdrawal.userPayloadHash)) {
    throw new PermanentError(`Tx ${txHash} published a user payload that does not match its user payload hash`);
  }
  return userPayload;
}

// ----------------------------------- end TEMPORARY -------------------------------------------
