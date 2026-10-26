import type { Fr } from '@aztec-labs/aztec.js/fields';

import { OxidePortalAbi } from '@oxide/l1-contracts/artifacts.js';
import { toOutboxWithdrawal } from '@oxide/oxide-lib/withdrawal_finalization_data.js';

import { type Hex, encodeFunctionData } from 'viem';

import { resolveArchive } from '../archive_ref.js';
import {
  type WithdrawalPortalContext,
  computeWithdrawalWitness,
  resolveWithdrawal,
  signWithdrawalFinalization,
} from '../utils/withdrawal.js';
import type { WithdrawalInTx } from '../withdrawal_in_tx.js';

/** Build direct Portal calldata for one withdrawal (for example a finalization request, or a withdrawal the owner
 *  recovered), verified against its initiation tx. The relayer uses it, and external clients use it too: the zk.money
 *  wallet self-finalizes with it. `archiveRoot` names the archive the TEE signature anchors: any proven checkpoint
 *  whose archive covers the initiation, or the freeze archive for a freeze-epoch withdrawal on a frozen portal. */
export async function buildWithdrawalFinalizationCalldata(
  ctx: WithdrawalPortalContext,
  args: {
    withdrawal: WithdrawalInTx;
    archiveRoot: Fr;
    relayerPayload: Buffer;
  },
): Promise<Hex> {
  const resolved = await resolveWithdrawal(ctx, args.withdrawal);
  const archive = await resolveArchive(ctx.chain, args.archiveRoot);
  const witness = await computeWithdrawalWitness({
    chain: ctx.chain,
    txHash: resolved.txHash,
    messageHash: resolved.messageHash,
    messageIndexInTx: resolved.messageIndexInTx,
  });
  const finalization = await signWithdrawalFinalization(ctx, {
    txHash: resolved.txHash,
    anchorBlockHash: resolved.anchorBlockHash,
    withdrawalSignature: resolved.finalizationData.withdrawalSignature,
    archive,
    messageHash: resolved.messageHash,
  });

  const content = toOutboxWithdrawal(resolved.finalizationData);
  return encodeFunctionData({
    abi: OxidePortalAbi,
    functionName: 'withdraw',
    args: [
      {
        content: {
          executor: content.executor.toString() as Hex,
          userPayloadHash: content.userPayloadHash.toString() as Hex,
          amount: content.amount,
          proverTip: content.proverTip,
          randomness: content.randomness.toBigInt(),
        },
        userPayload: `0x${resolved.finalizationData.userPayload.toString('hex')}` as Hex,
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
