import { RollupContract } from '@aztec/ethereum/contracts';
import { AztecNode } from '@aztec/stdlib/interfaces/client';

import { FrozenEvent, OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';
import { buildProverClaim } from '@oxide/oxide-client/atlatl/prover_claim.js';
import { computeSiloedWithdrawalTag, extractWithdrawalMessages } from '@oxide/oxide-client/published_withdrawal.js';
import { getWithdrawContentHash } from '@oxide/oxide-lib/content_hash.js';
import { TeeSigner } from '@oxide/oxide-lib/types.js';

import type { WatchContractEventReturnType } from 'viem';

import {
  BuildProverClaimResult,
  ObservedTx,
  PortalContext,
  ProverClaimDiscoveryPortalAdaptor,
  ProverClaimPortalAdaptor,
  ProverClaimResult,
  TxRef,
} from '../prover_claim_lib/index.js';

type ProverClaimFreeze = Pick<FrozenEvent, 'checkpointNumber' | 'epochNumber' | 'freezeCheckpointCount'>;

/** Dependencies needed to assemble submittable claims (the claim-collector path). */
export interface ProverClaimAdaptorDeps {
  node: AztecNode;
  portal: OxidePortalContract;
  rollup: RollupContract;
  signer: TeeSigner;
}

/** Discovery-only adaptor for the early-submit policy: finds prover-claimable messages; no signer needed. */
export class ProverClaimDiscoveryAdaptor implements ProverClaimDiscoveryPortalAdaptor {
  private unwatch?: WatchContractEventReturnType;

  protected constructor(
    /** Freeze boundary the adaptor gates against. Undefined until the portal freezes. */
    protected freeze: ProverClaimFreeze | undefined,
  ) {}

  static async create({ portal }: Pick<ProverClaimAdaptorDeps, 'portal'>): Promise<ProverClaimDiscoveryAdaptor> {
    const adaptor = new ProverClaimDiscoveryAdaptor(undefined);
    await adaptor.watchFreeze(portal);
    return adaptor;
  }

  /** Snapshot the freeze boundary, or watch for it on a live portal. */
  protected async watchFreeze(portal: OxidePortalContract): Promise<void> {
    this.unwatch = portal.listenToFrozen(event => {
      this.freeze = event;
      this.stop();
    });
    if (await portal.isFrozen()) {
      const [checkpointNumber, epochNumber, freezeCheckpointCount] = await Promise.all([
        portal.getFreezeCheckpointNumber(),
        portal.getFreezeEpochNumber(),
        portal.getFreezeCheckpointCount(),
      ]);
      this.freeze = { checkpointNumber, epochNumber, freezeCheckpointCount };
      this.stop();
    }
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = undefined;
  }

  async buildProverClaims(tx: ObservedTx, portal: PortalContext): Promise<ProverClaimResult[]> {
    if (this.isCutOffByFreeze(tx)) {
      return [];
    }
    const siloedTag = await computeSiloedWithdrawalTag(portal.l2Portal);
    return extractWithdrawalMessages(tx.txEffect, siloedTag).map((withdrawal, withdrawalIndex) => ({
      content: getWithdrawContentHash(
        withdrawal.executor,
        withdrawal.userPayloadHash,
        withdrawal.amount,
        withdrawal.proverTip,
        withdrawal.randomness,
      ),
      proverTip: withdrawal.proverTip,
      withdrawalIndex,
    }));
  }

  protected isCutOffByFreeze(tx: Pick<TxRef, 'epochNumber' | 'checkpointNumber'>): boolean {
    if (!this.freeze) {
      return false;
    }
    return (
      tx.epochNumber > this.freeze.epochNumber ||
      (tx.epochNumber === this.freeze.epochNumber && tx.checkpointNumber > this.freeze.checkpointNumber)
    );
  }
}

/** Discovery + claim assembly for the claim collector. Requires the TEE signer and chain handles. */
export class ProverClaimAdaptor extends ProverClaimDiscoveryAdaptor implements ProverClaimPortalAdaptor {
  private constructor(private readonly deps: ProverClaimAdaptorDeps) {
    super(undefined);
  }

  static async create(deps: ProverClaimAdaptorDeps): Promise<ProverClaimAdaptor> {
    const adaptor = new ProverClaimAdaptor(deps);
    await adaptor.watchFreeze(deps.portal);
    return adaptor;
  }

  async buildProverClaimData(
    tx: TxRef,
    withdrawalIndex: number,
    proofLength: bigint,
    portal: PortalContext,
  ): Promise<BuildProverClaimResult> {
    // Re-check the freeze boundary against the current snapshot: a freeze can land between discovery and assembly.
    if (this.isCutOffByFreeze(tx)) {
      return { status: 'error', reason: `Burn in epoch ${tx.epochNumber} is cut off by the freeze` };
    }

    // A freeze-epoch claim must verify against the pre-freeze root, so cap its proof length at the freeze
    // checkpoint count; a captured range that ran deeper (post-freeze proving) would otherwise revert on-chain.
    const effectiveProofLength =
      this.freeze !== undefined &&
      tx.epochNumber === this.freeze.epochNumber &&
      proofLength > this.freeze.freezeCheckpointCount
        ? this.freeze.freezeCheckpointCount
        : proofLength;
    const archiveRoot = await this.deps.rollup.archiveAt(tx.checkpointNumber);
    const proverClaim = await buildProverClaim(
      { ...this.deps, chain: this.deps.node, l2Token: portal.l2Portal },
      { txHash: tx.txHash, archiveRoot, withdrawalIndex, proofLength: effectiveProofLength },
    );
    return { status: 'success', proverClaim };
  }
}
