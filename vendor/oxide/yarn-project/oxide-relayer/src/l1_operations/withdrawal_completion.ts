import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import type { EthAddress } from '@aztec/foundation/eth-address';
import { computeL2ToL1MessageHash } from '@aztec/stdlib/hash';
import { TxHash } from '@aztec/stdlib/tx';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import { resolveBurnCheckpointArchive } from '@oxide/oxide-client/archive_ref.js';
import { buildWithdrawalPortalCalldata } from '@oxide/oxide-client/atlatl/process_withdrawal_request.js';
import type { ChainDataSource } from '@oxide/oxide-client/chain_data_source.js';
import { PermanentError } from '@oxide/oxide-client/errors.js';
import {
  type PublishedWithdrawal,
  fetchPublishedWithdrawals,
  plainWithdrawalUserPayload,
} from '@oxide/oxide-client/published_withdrawal.js';
import { getWithdrawContentHash } from '@oxide/oxide-lib/content_hash.js';
import { encodePlainRelayerPayload } from '@oxide/oxide-lib/plain_withdrawal.js';
import type { TeeSigner } from '@oxide/oxide-lib/types.js';

import type { Hex } from 'viem';

import type { PendingL1Operation } from '../state/types.js';

/** Whether the broadcast tx's withdrawal message has reached the Outbox. */
export type OutboxStatus = 'ready' | 'waiting' | 'unrecoverable';

/**
 * Completes an operation condition by `MessageInOutbox`.
 *
 * Completion consists of:
 * 1. Getting the L2 to L1 message witness,
 * 2. getting a finalization singature from a TEE.
 */
export class WithdrawalCompletion {
  constructor(
    private readonly chain: ChainDataSource,
    private readonly portal: OxidePortalContract,
    private readonly l2Token: AztecAddress,
    private readonly signer: TeeSigner,
    /** The only executor this relayer finalizes withdrawals for. */
    private readonly plainWithdrawalExecutor: EthAddress,
    /** Contract the executor pays the relayer tip to; it forwards the payout to the submitting relayer. */
    private readonly operationExecutor: EthAddress,
    /** Withdrawal subsidy the executor claims from, or zero to claim nothing. */
    private readonly withdrawalSubsidy: EthAddress,
  ) {}

  /** The `MESSAGE_IN_OUTBOX` gate. Costs one tx-effect read and one witness lookup; no enclave call. */
  async outboxStatus(l2TxHash: string): Promise<OutboxStatus> {
    const txHash = TxHash.fromString(l2TxHash);
    try {
      const withdrawal = await this.#publishedWithdrawal(txHash);
      // Derived from the preimage alone, so a hash the burn tx never emitted simply has no membership witness.
      const messageHash = computeL2ToL1MessageHash({
        l2Sender: this.l2Token,
        l1Recipient: this.portal.address,
        content: getWithdrawContentHash(
          withdrawal.executor,
          withdrawal.userPayloadHash,
          withdrawal.amount,
          withdrawal.proverTip,
          withdrawal.randomness,
        ),
        rollupVersion: new Fr(await this.portal.getRollupVersion()),
        chainId: new Fr(this.portal.getChainId()),
      });
      const witness = await this.chain.getL2ToL1MembershipWitness(txHash, messageHash);
      return witness ? 'ready' : 'waiting';
    } catch (err) {
      // A tx effect is immutable, so a missing or malformed publishing log can never become valid.
      return err instanceof PermanentError ? 'unrecoverable' : 'waiting';
    }
  }

  /**
   * The calldata to execute. Rebuilt on every attempt, so a witness built at one partial-proof depth is never
   * reused at another, and nothing is persisted.
   */
  async resolveCalldata(operation: PendingL1Operation): Promise<Hex> {
    const txHash = TxHash.fromString(operation.l2TxHash);
    const withdrawal = await this.#publishedWithdrawal(txHash);
    const archiveRoot = await resolveBurnCheckpointArchive(this.chain, txHash);
    return await buildWithdrawalPortalCalldata(
      { chain: this.chain, portal: this.portal, l2Token: this.l2Token, signer: this.signer },
      {
        txHash,
        archiveRoot,
        withdrawalIndex: 0,
        userPayload: withdrawal.userPayload,
        relayerPayload: encodePlainRelayerPayload({
          tipRecipient: this.operationExecutor,
          withdrawalSubsidy: this.withdrawalSubsidy,
        }),
      },
    );
  }

  /**
   * The single published withdrawal of the burn tx. Rejects any withdrawal this relayer cannot settle: the
   * payloads are rebuilt from the published metadata, so an executor it does not know has no payload to run.
   */
  async #publishedWithdrawal(txHash: TxHash): Promise<PublishedWithdrawal & { userPayload: Buffer }> {
    const { withdrawals } = await fetchPublishedWithdrawals(this.chain, txHash, this.l2Token);
    const withdrawal = withdrawals[0];
    if (!withdrawal) {
      throw new PermanentError(`Tx ${txHash} published no withdrawal`);
    }
    return { ...withdrawal, userPayload: plainWithdrawalUserPayload(withdrawal, this.plainWithdrawalExecutor, txHash) };
  }
}
