import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { TxHash } from '@aztec-labs/stdlib/tx';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import { resolveTxCheckpointArchive } from '@oxide/oxide-client/archive_ref.js';
import { buildWithdrawalFinalizationCalldata } from '@oxide/oxide-client/atlatl/withdrawal_finalization.js';
import type { ChainDataSource } from '@oxide/oxide-client/chain_data_source.js';
import { PermanentError } from '@oxide/oxide-client/errors.js';
import type { RegisteredTeeSigner } from '@oxide/oxide-client/types.js';
import { type WithdrawalInTx, verifyWithdrawalInTx } from '@oxide/oxide-client/withdrawal_in_tx.js';
import { encodeExecutorRelayerPayload } from '@oxide/oxide-lib/executor.js';
import { decodeFinalizationData } from '@oxide/oxide-lib/withdrawal_finalization_data.js';

import type { Hex } from 'viem';

import type { PendingL1Operation } from '../state/types.js';

/** Whether the initiation tx's withdrawal message has reached the Outbox, or why the operation can never complete. */
export type OutboxStatus = { status: 'ready' } | { status: 'waiting' } | { status: 'unrecoverable'; reason: string };

/**
 * Completes an operation condition by `MessageInOutbox`. The operation's stored calldata is the finalization request
 * that the wallet broadcast in the initiation tx: the finalization data of the withdrawal.
 *
 * Completion consists of:
 * 1. Getting the L2 to L1 message witness,
 * 2. getting a finalization signature from a TEE.
 */
export class WithdrawalCompletion {
  constructor(
    private readonly chain: ChainDataSource,
    private readonly portal: OxidePortalContract,
    private readonly l2Token: AztecAddress,
    private readonly signer: RegisteredTeeSigner,
    /** Contract the executor pays the relayer tip to; it forwards the payout to the submitting relayer. */
    private readonly operationExecutor: EthAddress,
  ) {}

  /** The `MESSAGE_IN_OUTBOX` gate. Costs one tx-effect read and one witness lookup; no enclave call. */
  async outboxStatus(operation: PendingL1Operation): Promise<OutboxStatus> {
    try {
      const withdrawal = this.#decodeRequest(operation);
      const { messageHash, messageIndexInTx } = await verifyWithdrawalInTx(
        this.chain,
        await this.portal.getPortalDomain(),
        withdrawal,
      );
      const witness = await this.chain.getL2ToL1MembershipWitness(withdrawal.txHash, messageHash, messageIndexInTx);
      return { status: witness ? 'ready' : 'waiting' };
    } catch (err) {
      // The request and the tx effect are immutable, so a request that does not decode or match can never become valid.
      return err instanceof PermanentError ? { status: 'unrecoverable', reason: err.message } : { status: 'waiting' };
    }
  }

  /**
   * The calldata to execute. Rebuilt on every attempt, so a witness built at one partial-proof depth is never
   * reused at another, and nothing is persisted.
   */
  async resolveCalldata(operation: PendingL1Operation): Promise<Hex> {
    const withdrawal = this.#decodeRequest(operation);
    const archiveRoot = await resolveTxCheckpointArchive(this.chain, withdrawal.txHash);
    return await buildWithdrawalFinalizationCalldata(
      { chain: this.chain, portal: this.portal, l2Token: this.l2Token, signer: this.signer },
      {
        withdrawal,
        archiveRoot,
        relayerPayload: encodeExecutorRelayerPayload({ tipRecipient: this.operationExecutor }),
      },
    );
  }

  /**
   * Decode a finalization request for this portal. The executor and user payload pass through unchanged;
   * simulation checks whether execution succeeds and pays enough to relay.
   */
  #decodeRequest(operation: PendingL1Operation): WithdrawalInTx {
    if (!operation.target.equals(this.portal.address)) {
      throw new PermanentError(`Finalization request targets ${operation.target}, not portal ${this.portal.address}`);
    }
    let withdrawal: WithdrawalInTx;
    try {
      withdrawal = {
        txHash: TxHash.fromString(operation.l2TxHash),
        finalizationData: decodeFinalizationData(operation.calldata),
      };
    } catch (error) {
      throw new PermanentError(`Tx ${operation.l2TxHash} broadcast a malformed finalization request: ${error}`);
    }
    return withdrawal;
  }
}
