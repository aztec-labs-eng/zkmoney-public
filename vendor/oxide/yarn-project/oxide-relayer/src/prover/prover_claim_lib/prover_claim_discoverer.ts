import { asyncMap } from '@aztec/foundation/async-map';
import { EpochNumber } from '@aztec/foundation/branded-types';
import { Logger, createLogger } from '@aztec/foundation/log';
import { Checkpoint } from '@aztec/stdlib/checkpoint';
import { computeL2ToL1MessageHash } from '@aztec/stdlib/hash';
import { getL2ToL1MessageLeafId } from '@aztec/stdlib/messaging';

import { L2ToL1MessageIndexer } from '../l2_to_l1_message_indexer.js';
import { Binding, ObservedTx, portalId } from '../types.js';
import { DiscoveredClaim, ProverPortalConfig } from './types.js';

export interface ProverClaimDiscovererOptions {
  binding: Binding;
  portals: ProverPortalConfig[];
  log?: Logger;
}

export class ProverClaimDiscoverer {
  private readonly log: Logger;

  constructor(private readonly options: ProverClaimDiscovererOptions) {
    this.log = options.log ?? createLogger('atlatl:prover-claim-discoverer');
  }

  async discover(
    epoch: EpochNumber,
    newCheckpoints: Checkpoint[],
    checkpointsInEpoch: Checkpoint[],
  ): Promise<DiscoveredClaim[]> {
    const indexer = new L2ToL1MessageIndexer(checkpointsInEpoch);
    const txs = toObservedTxs(epoch, newCheckpoints);

    const discovered = (
      await Promise.all(
        this.options.portals.map(async portal =>
          (await asyncMap(txs, tx => this.buildClaims(portal, tx, indexer))).flat(),
        ),
      )
    ).flat();

    this.log.debug(`Discovered ${discovered.length} possible claim(s) across ${newCheckpoints.length} checkpoint(s)`);
    return discovered;
  }

  private async buildClaims(
    portal: ProverPortalConfig,
    tx: ObservedTx,
    indexer: L2ToL1MessageIndexer,
  ): Promise<DiscoveredClaim[]> {
    const id = portalId(portal.context.l1Portal);
    try {
      const claims = await portal.adaptor.buildProverClaims(tx, portal.context);
      return claims.map(({ content, proverTip, withdrawalIndex, messageIndexInTx }) => {
        const message = computeL2ToL1MessageHash({
          l2Sender: portal.context.l2Portal,
          l1Recipient: portal.context.l1Portal,
          content,
          rollupVersion: this.options.binding.rollupVersion,
          chainId: this.options.binding.chainId,
        });
        const leafIndex = indexer.getLeafIndex(tx, message, messageIndexInTx);
        const siblingPath = indexer.getSiblingPath(tx, message, messageIndexInTx);
        const rewardContext = {
          epochNumber: tx.epochNumber,
          messageLeafIndex: leafIndex,
          pathLength: BigInt(siblingPath.pathSize),
          tip: proverTip,
        };
        return {
          portalId: id,
          checkpointNumber: tx.checkpointNumber,
          rewardContext,
          txRef: {
            epochNumber: tx.epochNumber,
            checkpointNumber: tx.checkpointNumber,
            blockNumber: tx.blockNumber,
            txHash: tx.txEffect.txHash,
          },
          withdrawalIndex,
          leafId: getL2ToL1MessageLeafId({ leafIndex, siblingPath }),
        };
      });
    } catch (error) {
      this.log.error(`Failed to build prover claims for portal ${id} at checkpoint ${tx.checkpointNumber}: ${error}`);
      // TODO: Retry. Something unexpected happened. If the error is expected, the adaptor should return an empty array.
      return [];
    }
  }
}

function toObservedTxs(epochNumber: EpochNumber, checkpoints: Checkpoint[]): ObservedTx[] {
  const txs: ObservedTx[] = [];
  for (const checkpoint of checkpoints) {
    for (const block of checkpoint.blocks) {
      block.body.txEffects.forEach((txEffect, txIndexInBlock) => {
        txs.push({
          epochNumber,
          checkpointNumber: checkpoint.number,
          blockNumber: block.number,
          txIndexInBlock,
          txEffect,
        });
      });
    }
  }
  return txs;
}
