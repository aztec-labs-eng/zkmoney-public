import { CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { Logger, createLogger } from '@aztec/foundation/log';
import { Checkpoint } from '@aztec/stdlib/checkpoint';

import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';

import { ChainlinkPriceOracle } from '../../price_oracle/chainlink_price_oracle.js';
import { ProverClaimDiscoverer } from '../prover_claim_lib/prover_claim_discoverer.js';
import { portalId } from '../types.js';
import { DiscoveredClaim, EarlySubmitPortalConfig, PartialProofDecision, ProverProfitEstimate } from './types.js';

const BPS_DENOMINATOR = 10_000n;

interface EpochCache {
  toCheckpoint: CheckpointNumber;
  // Archive root of the checkpoint at `toCheckpoint` when the claims were discovered.
  tipArchive: string;
  claims: DiscoveredClaim[];
}

export interface EpochProfitTrackerOptions {
  discoverer: ProverClaimDiscoverer;
  portal: OxidePortalContract;
  portals: EarlySubmitPortalConfig[];
  priceOracle: ChainlinkPriceOracle;
  /** The per-gas price the proof submission tx is expected to pay. */
  getEffectiveGasPriceWei: () => Promise<bigint>;
  rollupSubmitEpochProofGas: bigint;
  minEpochProfit: bigint;
  minEpochProfitMarginBps: bigint;
  provingCostPerCheckpoint: bigint;
  log?: Logger;
}

export class EpochProfitTracker {
  private readonly portals = new Map<string, EarlySubmitPortalConfig>();
  private cache = new Map<EpochNumber, EpochCache>();
  private readonly log: Logger;

  constructor(private readonly options: EpochProfitTrackerOptions) {
    for (const portal of options.portals) {
      this.portals.set(portalId(portal.context.l1Portal), portal);
    }

    this.log = options.log ?? createLogger('atlatl:epoch-profit-tracker');
  }

  /**
   * Decide whether to submit a partial proof for `epoch`'s current `checkpoints`.
   */
  async evaluate(epoch: EpochNumber, checkpoints: Checkpoint[]): Promise<PartialProofDecision> {
    if (!checkpoints.length) {
      return { submit: false, reason: 'no checkpoints' };
    }

    this.evictEpochsBelow(epoch);

    const cached = this.validCache(epoch, checkpoints) ?? { toCheckpoint: CheckpointNumber(0), claims: [] };

    // Discover claims for checkpoints not seen before.
    let claims = cached.claims;
    const newCheckpoints = checkpoints.filter(checkpoint => checkpoint.number > cached.toCheckpoint);
    if (newCheckpoints.length > 0) {
      const newClaims = await this.options.discoverer.discover(epoch, newCheckpoints, checkpoints);
      claims = [...claims, ...newClaims];
    }

    const tip = checkpoints.at(-1)!;
    this.cache.set(epoch, { toCheckpoint: tip.number, tipArchive: tip.archive.root.toString(), claims });

    // Skip claims at or below the highest checkpoint another prover has already captured.
    const lastCovered = await this.coveredThrough(checkpoints);
    const uncovered = claims.filter(claim => claim.checkpointNumber > lastCovered);
    if (uncovered.length === 0) {
      return { submit: false, reason: 'no claimable tips' };
    }

    const { estimate, submit } = await this.computeProfit(uncovered, checkpoints.length);

    return {
      submit,
      reason: submit ? 'profitable' : 'unprofitable',
      details: {
        profit: estimate.profit,
        totalRewardValue: estimate.rewardValue,
        totalGasCostValue: estimate.gasCostValue,
        provingCostValue: estimate.provingCostValue,
        totalGas: estimate.gas,
        claimCount: estimate.claimCount,
      },
    };
  }

  /**
   * The checkpoint at the cached tip number must exist and carry the cached archive root. A miss means a reorg
   * dropped or replaced content the claims were discovered from, so the cache is dropped and the whole prefix
   * is re-discovered.
   */
  private validCache(epoch: EpochNumber, checkpoints: Checkpoint[]): EpochCache | undefined {
    const cached = this.cache.get(epoch);
    if (!cached) {
      return undefined;
    }
    const tip = checkpoints.find(c => c.number === cached.toCheckpoint);
    if (tip && tip.archive.root.toString() === cached.tipArchive) {
      return cached;
    }
    this.log.debug(`Epoch ${epoch} cached claims no longer match canonical content, rediscovering`);
    this.cache.delete(epoch);
    return undefined;
  }

  /**
   * Highest checkpoint in `checkpoints` already covered by a recorded first prover, or 0 if none.
   *
   * Coverage is read fresh from the L1 head and never stored, so a record later dropped by a reorg suppresses at
   * most the current decision; the next evaluation re-reads and recovers.
   */
  private async coveredThrough(checkpoints: Checkpoint[]): Promise<CheckpointNumber> {
    const head = await this.options.portal.client.getBlockNumber();
    // The common early-proof case has nothing covered, which reads every checkpoint; issue them concurrently.
    // All reads are pinned to one block so the boundary comes from a single consistent snapshot.
    const provers = await Promise.all(
      checkpoints.map(c => this.options.portal.firstProver(c.number, { blockNumber: head })),
    );
    for (let i = checkpoints.length - 1; i >= 0; i--) {
      if (!provers[i].isZero()) {
        this.log.debug(`Checkpoint ${checkpoints[i].number} covered by a recorded first prover`);
        return checkpoints[i].number;
      }
    }
    return CheckpointNumber(0);
  }

  /** Drop cached claims for epochs older than `epoch`: once a newer epoch is being evaluated, the
   *  older ones are finalized and won't be re-evaluated. */
  private evictEpochsBelow(epoch: EpochNumber): void {
    for (const cachedEpoch of this.cache.keys()) {
      if (cachedEpoch < epoch) {
        this.cache.delete(cachedEpoch);
      }
    }
  }

  private async computeProfit(
    claims: DiscoveredClaim[],
    checkpointCount: number,
  ): Promise<{ estimate: ProverProfitEstimate; submit: boolean }> {
    const byPortal = new Map<string, DiscoveredClaim[]>();
    for (const claim of claims) {
      const group = byPortal.get(claim.portalId) ?? [];
      group.push(claim);
      byPortal.set(claim.portalId, group);
    }

    // Claiming happens later, in a cheap-gas window, so a claim's reward is its tip plus the flat subsidy and
    // its gas is not a cost of the epoch.
    const groups = [...byPortal.entries()];
    const settled = await Promise.allSettled(
      groups.map(async ([, portalClaims]) => {
        const portal = this.portals.get(portalClaims[0].portalId)!;
        const subsidy = await portal.quoteProverSubsidy(BigInt(portalClaims.length));
        const totalTip = portalClaims.reduce((sum, claim) => sum + claim.rewardContext.tip, 0n);
        return { rewardValue: totalTip + subsidy, claimCount: portalClaims.length };
      }),
    );
    // A portal whose pricing fails contributes nothing: reward is understated, never overstated, and the
    // other portals still count toward the epoch's profit.
    const portalEstimates = settled.flatMap((result, i) => {
      if (result.status === 'rejected') {
        this.log.error(`Failed to price prover claims for portal ${groups[i][0]}: ${result.reason}`);
        return [];
      }
      return [result.value];
    });

    const { rewardValue, claimCount } = portalEstimates.reduce(
      (acc, estimate) => {
        return {
          rewardValue: acc.rewardValue + estimate.rewardValue,
          claimCount: acc.claimCount + estimate.claimCount,
        };
      },
      { rewardValue: 0n, claimCount: 0 },
    );

    const gas = this.options.rollupSubmitEpochProofGas;
    const effectiveGasPriceWei = await this.options.getEffectiveGasPriceWei();
    const gasCostValue = await this.options.priceOracle.weiToUSD(gas * effectiveGasPriceWei);
    const provingCostValue = this.options.provingCostPerCheckpoint * BigInt(checkpointCount);
    const profit = rewardValue - gasCostValue - provingCostValue;

    const submit =
      claimCount > 0 &&
      profit >= this.options.minEpochProfit &&
      profit * BPS_DENOMINATOR >= rewardValue * this.options.minEpochProfitMarginBps;

    return { submit, estimate: { profit, rewardValue, gasCostValue, provingCostValue, gas, claimCount } };
  }
}
