import type { Fr } from '@aztec/aztec.js/fields';
import type { TxHash } from '@aztec/stdlib/tx';

import { OxidePortalAbi } from '@oxide/l1-contracts/artifacts.js';
import { computeWithdrawMessageHash } from '@oxide/oxide-lib/hash.js';

import { type Hex, encodeFunctionData } from 'viem';

import { resolveArchive } from '../archive_ref.js';
import type { L1SubmitContext } from '../types.js';
import { computeWithdrawalWitness, fromPublished, signWithdrawFinalization } from '../utils/withdrawal.js';

/** What {@link buildWithdrawalPortalCalldata} reads from its context. A client can give the portal identity it knows
 *  without an L1 client. */
export type WithdrawalPortalCalldataContext = Pick<L1SubmitContext, 'chain' | 'signer' | 'l2Token'> & {
  portal: Pick<L1SubmitContext['portal'], 'address' | 'getRollupVersion' | 'getChainId'>;
};

/** Build direct Portal calldata for one withdrawal published in `txHash`'s burn
 *  tx. The relayer uses it, and external clients use it too: the zk.money wallet self-finalizes with it.
 *  `archiveRoot` names the archive the TEE signature anchors: any proven checkpoint whose archive covers
 *  the burn, or the freeze archive for a freeze-epoch withdrawal on a frozen portal.
 *  `withdrawalIndex` selects which entry in the burn tx's published-withdrawal log to finalise. */
export async function buildWithdrawalPortalCalldata(
  ctx: WithdrawalPortalCalldataContext,
  args: {
    txHash: TxHash;
    archiveRoot: Fr;
    withdrawalIndex: number;
    userPayload: Buffer;
    relayerPayload: Buffer;
    messageIndexInTx?: number;
  },
): Promise<Hex> {
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
  const witness = await computeWithdrawalWitness({
    chain: ctx.chain,
    txHash: inputs.txHash,
    messageHash,
    messageIndexInTx: args.messageIndexInTx,
  });
  const finalization = await signWithdrawFinalization(ctx, {
    txHash: inputs.txHash,
    anchorBlockHash: inputs.anchorBlockHash,
    withdrawalSignature: inputs.withdrawalSignature,
    archive,
    messageHash,
  });

  return encodeFunctionData({
    abi: OxidePortalAbi,
    functionName: 'withdraw',
    args: [
      {
        content: {
          executor: inputs.executor.toString() as Hex,
          userPayloadHash: inputs.userPayloadHash.toString() as Hex,
          amount: inputs.amount,
          proverTip: inputs.proverTip,
          randomness: inputs.randomness.toBigInt(),
        },
        userPayload: `0x${args.userPayload.toString('hex')}` as Hex,
        relayerPayload: `0x${args.relayerPayload.toString('hex')}` as Hex,
        epochNumber: BigInt(witness.epochNumber),
        numCheckpointsInEpoch: witness.numCheckpointsInEpoch,
        leafIndex: witness.leafIndex,
        path: witness.siblingPath.map(p => p.toString() as Hex),
        checkpointNumber: BigInt(archive.checkpointNumber),
        withdrawalId: finalization.withdrawalId.toString() as Hex,
        teeSignature: finalization.signature.toString() as Hex,
      },
    ],
  });
}
