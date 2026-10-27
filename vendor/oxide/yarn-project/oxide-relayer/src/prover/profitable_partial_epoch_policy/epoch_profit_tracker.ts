import { RollupContract } from '@aztec-labs/ethereum/contracts/rollup';
import { CheckpointNumber, EpochNumber } from '@aztec-labs/foundation/branded-types';
import { Logger, createLogger } from '@aztec-labs/foundation/log';
import { Checkpoint } from '@aztec-labs/stdlib/checkpoint';

import {
  type ClaimProverTipsGasModel,
  type SubmitEpochProofGasModel,
  claimProverTipsGas,
  computePartialEpochProofProfit,
  submitEpochProofGas,
} from '@oxide/oxide-client/partial_epoch_proof_profit.js';

import { isAboveMaxFeePerGas } from '../../l1/l1_tx_queue.js';
import { type PriceOracle, tokenToUsd, weiToUsd } from '../../price_oracle/price_oracle.js';
import { selectProfitableBatch } from '../batch_selection.js';
import { ProverClaimDiscoverer } from '../prover_claim_lib/prover_claim_discoverer.js';
import { portalId } from '../types.js';
import { DiscoveredClaim, EarlySubmitPortalConfig, PartialProofDecision, ProverProfitEstimate } from './types.js';

interface EpochCache {
  toCheckpoint: CheckpointNumber;
  // Archive root of the checkpoint at `toCheckpoint` when the claims were discovered.
  tipArchive: string;
  claims: DiscoveredClaim[];
}

export interface EpochProfitTrackerOptions {
  discoverer: ProverClaimDiscoverer;
  rollup: RollupContract;
  portals: EarlySubmitPortalConfig[];
  priceOracle: PriceOracle;
  /** The per-gas price the proof submission tx and the claim txs are expected to pay. */
  getEffectiveGasPriceWei: () => Promise<bigint>;
  /**
   * The `maxFeePerGas` that the claim batch submitter prices a batch at. The tracker selects the claims at this
   * price, as the submitter does, so that it counts only the claims that the submitter will send.
   */
  getClaimMaxFeePerGasWei: () => Promise<bigint>;
  /**
   * The operator cap on `maxFeePerGas`. The claim batch submitter sends no claims while the fee is above it, so the
   * tracker does not start a proof then. No cap when unset.
   */
  maxFeePerGasCap?: bigint;
  submitEpochProofGasModel: SubmitEpochProofGasModel;
  claimProverTipsGasModel: ClaimProverTipsGasModel;
  minEpochProfit: bigint;
  minEpochProfitMarginBps: bigint;
  provingCostPerCheckpoint: bigint;
  minClaimBatchProfit: bigint;
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

    // Skip claims at or below the proven tip. The rollup already recorded a first prover for them.
    const lastCovered = await this.coveredThrough();
    const uncovered = claims.filter(claim => claim.checkpointNumber > lastCovered);
    if (uncovered.length === 0) {
      return { submit: false, reason: 'no claimable tips' };
    }

    // One price for the whole evaluation.
    const [ethPrice, effectiveGasPriceWei, claimMaxFeePerGasWei] = await Promise.all([
      this.options.priceOracle.getEthPrice(),
      this.options.getEffectiveGasPriceWei(),
      this.options.getClaimMaxFeePerGasWei(),
    ]);
    if (isAboveMaxFeePerGas(this.options, claimMaxFeePerGasWei)) {
      return { submit: false, reason: 'max fee per gas above the cap' };
    }

    const { estimate, submit } = await this.computeProfit(uncovered, checkpoints.length, {
      ethPrice,
      effectiveGasPriceWei,
      claimMaxFeePerGasWei,
    });

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
   * Highest checkpoint already covered by a recorded first prover: the proven tip, read at the L1 head.
   *
   * Coverage is read fresh from the L1 head and never stored, so a record later dropped by a reorg suppresses at
   * most the current decision; the next evaluation re-reads and recovers.
   */
  private async coveredThrough(): Promise<CheckpointNumber> {
    const head = await this.options.rollup.client.getBlockNumber();
    return await this.options.rollup.getProvenCheckpointNumber({ blockNumber: head });
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
    prices: { ethPrice: bigint; effectiveGasPriceWei: bigint; claimMaxFeePerGasWei: bigint },
  ): Promise<{ estimate: ProverProfitEstimate; submit: boolean }> {
    const { ethPrice, effectiveGasPriceWei, claimMaxFeePerGasWei } = prices;
    const byPortal = new Map<string, DiscoveredClaim[]>();
    for (const claim of claims) {
      const group = byPortal.get(claim.portalId) ?? [];
      group.push(claim);
      byPortal.set(claim.portalId, group);
    }

    const groups = [...byPortal.entries()];
    const settled = await Promise.allSettled(
      groups.map(([, portalClaims]) => this.selectClaims(portalClaims, claimMaxFeePerGasWei, ethPrice)),
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

    const { rewardValue, claimCount, claimGas } = portalEstimates.reduce(
      (acc, estimate) => {
        return {
          rewardValue: acc.rewardValue + estimate.rewardValue,
          claimCount: acc.claimCount + estimate.claimCount,
          claimGas: acc.claimGas + estimate.claimGas,
        };
      },
      { rewardValue: 0n, claimCount: 0, claimGas: 0n },
    );

    const gas = submitEpochProofGas(BigInt(checkpointCount), this.options.submitEpochProofGasModel) + claimGas;
    const gasCostValue = weiToUsd(gas * effectiveGasPriceWei, ethPrice);
    const { profit, provingCostValue, profitable } = computePartialEpochProofProfit({
      rewardValue,
      gasCostValue,
      checkpointCount: BigInt(checkpointCount),
      minEpochProfit: this.options.minEpochProfit,
      minEpochProfitMarginBps: this.options.minEpochProfitMarginBps,
      provingCostPerCheckpoint: this.options.provingCostPerCheckpoint,
    });
    const submit = claimCount > 0 && profitable;

    return { submit, estimate: { profit, rewardValue, gasCostValue, provingCostValue, gas, claimCount } };
  }

  /**
   * The claims of one portal that the claim batch submitter will send, with their reward and claim gas.
   *
   * The proof cost is paid before the claims are sent, so the submitter prices a batch against its own gas at
   * `maxFeePerGas` and leaves out a claim whose reward does not pay for its gas. The tracker selects in the same way,
   * so that it does not count the reward of a claim that the submitter will not send.
   *
   * Only the first batch counts. A partial proof that needs more than one batch of tips to be profitable is not
   * expected, so the claims after it are left out and the reward is understated, never overstated.
   */
  private async selectClaims(
    portalClaims: DiscoveredClaim[],
    claimMaxFeePerGasWei: bigint,
    ethPrice: bigint,
  ): Promise<{ rewardValue: bigint; claimCount: number; claimGas: bigint }> {
    const portal = this.portals.get(portalClaims[0].portalId)!;
    // The tips and the subsidy are both in the portal's own token, so one price values the whole selection.
    const tokenPrice = await this.options.priceOracle.getTokenPrice(portal.context.token);
    const tipOf = (claim: DiscoveredClaim) => claim.rewardContext.tip;
    const { batch, quote } = await selectProfitableBatch(
      portalClaims,
      async subset => {
        const claimCount = BigInt(subset.length);
        return {
          totalGas: claimProverTipsGas(claimCount, this.options.claimProverTipsGasModel),
          subsidy: claimCount === 0n ? 0n : await portal.quoteProverSubsidy(claimCount),
        };
      },
      {
        tipOf,
        minProfit: this.options.minClaimBatchProfit,
        rewardValueOf: reward => tokenToUsd(reward, tokenPrice),
        gasCostOf: gas => weiToUsd(gas * claimMaxFeePerGasWei, ethPrice),
      },
    );

    if (batch.length < portalClaims.length) {
      this.log.debug(
        `Leaving out ${portalClaims.length - batch.length} prover claim(s) on portal ${portalClaims[0].portalId}: they do not pay for their gas at max fee per gas ${claimMaxFeePerGasWei}, or they are after the first batch`,
      );
    }
    return {
      rewardValue: tokenToUsd(batch.reduce((sum, claim) => sum + tipOf(claim), 0n) + quote.subsidy, tokenPrice),
      claimCount: batch.length,
      claimGas: quote.totalGas,
    };
  }
}
