import type { Fr } from '@aztec-labs/aztec.js/fields';

import type { ProverClaim } from '@oxide/l1-contracts/oxide_portal.js';
import { toOutboxWithdrawal } from '@oxide/oxide-lib/withdrawal_finalization_data.js';

import type { Hex } from 'viem';

import { resolveArchive } from '../archive_ref.js';
import type { L1SubmitContext } from '../types.js';
import { computeProverClaimWitness, resolveWithdrawal, signWithdrawalFinalization } from '../utils/withdrawal.js';
import type { WithdrawalInTx } from '../withdrawal_in_tx.js';

/** Build a Portal `claimProverTips` request for one withdrawal (for example a finalization request), verified against
 *  its initiation tx. `archiveRoot` anchors the TEE finalization signature — any proven checkpoint whose archive covers
 *  the initiation. `proofLength` is the shortest proof that proves the checkpoint of the initiation tx. */
export async function buildProverClaim(
  ctx: L1SubmitContext,
  args: {
    withdrawal: WithdrawalInTx;
    archiveRoot: Fr;
    proofLength: bigint;
  },
): Promise<ProverClaim> {
  const resolved = await resolveWithdrawal(ctx, args.withdrawal);
  const archive = await resolveArchive(ctx.chain, args.archiveRoot);
  const finalization = await signWithdrawalFinalization(ctx, {
    txHash: resolved.txHash,
    anchorBlockHash: resolved.anchorBlockHash,
    withdrawalSignature: resolved.finalizationData.withdrawalSignature,
    archive,
    messageHash: resolved.messageHash,
  });

  const witness = await computeProverClaimWitness({
    chain: ctx.chain,
    txHash: resolved.txHash,
    messageHash: resolved.messageHash,
    claimProofLength: args.proofLength,
    messageIndexInTx: resolved.messageIndexInTx,
  });

  const content = toOutboxWithdrawal(resolved.finalizationData);
  return {
    claimArgs: {
      content: { ...content, randomness: content.randomness.toBigInt() },
      checkpointNumber: archive.checkpointNumber,
      withdrawalId: finalization.withdrawalId,
      teeSignature: finalization.signature,
    },
    path: witness.path.map(p => p.toString() as Hex),
    proofLength: args.proofLength,
    checkpointNumber: witness.checkpointNumber,
    epochNumber: witness.epochNumber,
    messageLeafIndex: witness.leafIndex,
  };
}
