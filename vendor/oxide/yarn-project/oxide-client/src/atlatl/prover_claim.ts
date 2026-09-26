import type { Fr } from '@aztec/aztec.js/fields';
import type { TxHash } from '@aztec/stdlib/tx';

import type { ProverClaim } from '@oxide/l1-contracts/oxide_portal.js';
import { computeWithdrawMessageHash } from '@oxide/oxide-lib/hash.js';

import type { Hex } from 'viem';

import { resolveArchive } from '../archive_ref.js';
import type { L1SubmitContext } from '../types.js';
import { computeProverClaimWitness, fromPublished, signWithdrawFinalization } from '../utils/withdrawal.js';

/** Build a Portal `claimProverTips` request for a single withdrawal published in `txHash`'s burn tx.
 *  `withdrawalIndex` selects which `publish_withdrawal` log entry to claim. `archiveRoot` anchors the
 *  TEE finalization signature — any proven checkpoint whose archive covers the burn. `proofLength` is
 *  the shortest proof that proves the checkpoint containing the burn tx. */
export async function buildProverClaim(
  ctx: L1SubmitContext,
  args: {
    txHash: TxHash;
    archiveRoot: Fr;
    withdrawalIndex: number;
    proofLength: bigint;
  },
): Promise<ProverClaim> {
  const inputs = await fromPublished(ctx.chain, args.txHash, args.withdrawalIndex, ctx.l2Token);
  const archive = await resolveArchive(ctx.chain, args.archiveRoot);
  const messageHash = computeWithdrawMessageHash(
    {
      l2Portal: ctx.l2Token,
      l1Portal: ctx.portal.address,
      rollupVersion: await ctx.portal.getRollupVersion(),
      l1ChainId: ctx.portal.getChainId(),
    },
    inputs,
  );
  const finalization = await signWithdrawFinalization(ctx, {
    txHash: inputs.txHash,
    anchorBlockHash: inputs.anchorBlockHash,
    withdrawalSignature: inputs.withdrawalSignature,
    archive,
    messageHash,
  });

  const witness = await computeProverClaimWitness({
    chain: ctx.chain,
    txHash: inputs.txHash,
    messageHash,
    claimProofLength: args.proofLength,
  });

  const path = witness.path.map(p => p.toString() as Hex);
  return {
    claimArgs: {
      content: {
        executor: inputs.executor,
        userPayloadHash: inputs.userPayloadHash,
        amount: inputs.amount,
        proverTip: inputs.proverTip,
        randomness: inputs.randomness.toBigInt(),
      },
      checkpointNumber: archive.checkpointNumber,
      withdrawalId: finalization.withdrawalId,
      teeSignature: finalization.signature,
    },
    path,
    proofLength: args.proofLength,
    checkpointNumber: witness.checkpointNumber,
    epochNumber: witness.epochNumber,
    messageLeafIndex: witness.leafIndex,
  };
}
