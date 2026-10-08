import { RollupContract } from '@aztec/ethereum/contracts/rollup';
import { EthAddress } from '@aztec/foundation/eth-address';
import { Logger, createLogger } from '@aztec/foundation/log';
import { RunningPromise } from '@aztec/foundation/running-promise';

import { OxidePortalContract, ProverClaim, toProverTipClaim } from '@oxide/l1-contracts/oxide_portal.js';

import { type FeeValuesEIP1559, maxUint256 } from 'viem';

import { isAboveMaxFeePerGas } from '../../l1/l1_tx_queue.js';
import { ChainlinkPriceOracle } from '../../price_oracle/chainlink_price_oracle.js';
import { MAX_ITEMS_PER_BATCH, selectProfitableBatch, sortByTipDescending } from '../batch_selection.js';
import { ProverClaimPortalConfig } from '../prover_claim_lib/index.js';
import { portalId } from '../types.js';
import { BatchPublisher } from './batch_publisher.js';
import { PendingProverClaim, ProverClaimBacklog } from './prover_claim_backlog.js';

export interface ProfitableClaimBatchSubmitterOptions {
  portal: OxidePortalContract;
  rollup: RollupContract;
  portals: ProverClaimPortalConfig[];
  backlog: ProverClaimBacklog;
  priceOracle: ChainlinkPriceOracle;
  /** The fee values of the batch tx. The batch is priced at their `maxFeePerGas`, the most that the tx can pay per gas. */
  getFeeValues: () => Promise<FeeValuesEIP1559>;
  /** Operator cap on `maxFeePerGas`, in wei. The batch is deferred while its fee values are above it. */
  maxFeePerGasCap?: bigint;
  publisher: BatchPublisher;
  /**
   * Account the gas simulation runs as, and the account that must sign the batch. It must be the prover:
   * `claimProverTips` credits `msg.sender`, and `ProverClaimLib` requires it to be the address recorded in
   * `$firstProver` for the claim's checkpoint.
   */
  senderAddress: EthAddress;
  /** Minimum batch profit in the oracle's common quote currency: a batch below it is not worth a tx. */
  minBatchProfit: bigint;
  intervalMs: number;
  onError?: (error: unknown) => void | Promise<void>;
  log?: Logger;
}

/**
 * Re-prices the backlogged claims and publishes the most profitable batch they can form right now.
 *
 * A prover claim expires: the rollup keeps the checkpoint log it verifies against for only about an hour. So the
 * submitter never waits for a better price. It submits as soon as a batch clears the profit floor, and drops a claim
 * when its deadline arrives with the cost still above the tip.
 */
export class ProfitableClaimBatchSubmitter {
  private readonly loops: RunningPromise[] = [];
  private readonly portals = new Map<string, ProverClaimPortalConfig>();
  private readonly log: Logger;
  /** Set while the fee is above the cap, so the deferral logs at info once for each spike. */
  #aboveMaxFeePerGas = false;

  constructor(private readonly options: ProfitableClaimBatchSubmitterOptions) {
    this.log = options.log ?? createLogger('atlatl:prover-claim-batch-submitter');
    for (const portal of options.portals) {
      this.portals.set(portalId(portal.context.l1Portal), portal);
    }
  }

  start(): void {
    if (this.loops.length > 0) {
      throw new Error('ProfitableClaimBatchSubmitter already started');
    }
    for (const portal of this.options.portals) {
      const loop = new RunningPromise(
        () => this.pollPortal(portalId(portal.context.l1Portal)),
        this.log,
        this.options.intervalMs,
      );
      loop.start();
      this.loops.push(loop);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.loops.map(loop => loop.stop()));
    this.loops.length = 0;
  }

  async pollPortal(id: string): Promise<void> {
    try {
      // A batch already in flight holds claims that a second batch could repeat. `claimProverTips` reverts
      // the whole tx on a repeated claim, so never select while one is out.
      if (this.options.backlog.isPublishing(id)) {
        return;
      }

      const backlogged = this.options.backlog.getPortalClaims(id);
      if (backlogged.length === 0) {
        return;
      }

      const live = await this.#dropExpired(backlogged);
      if (live.length === 0) {
        return;
      }

      const unclaimed = await this.#dropAlreadyClaimed(live);
      if (unclaimed.length === 0) {
        return;
      }

      await this.#evaluatePortal(this.portals.get(id)!, unclaimed);
    } catch (error) {
      this.log.error(`Error polling portal ${id}: ${error}`);
      if (this.options.onError) {
        await this.options.onError(error);
      } else {
        throw error;
      }
    }
  }

  /** Drop claims the rollup can no longer verify. Their tip is gone; say so loudly. */
  async #dropExpired(claims: PendingProverClaim[]): Promise<PendingProverClaim[]> {
    const pending = await this.options.rollup.getCheckpointNumber();
    const expired = claims.filter(claim => claim.deadlinePending < pending);
    if (expired.length > 0) {
      this.log.warn(
        `Dropping ${expired.length} expired prover claim(s) at pending checkpoint ${pending}: ` +
          expired.map(c => `${c.id} (tip ${c.claim.rewardContext.tip}, deadline ${c.deadlinePending})`).join(', '),
      );
      this.options.backlog.resolve(expired.map(claim => claim.id));
    }
    return claims.filter(claim => claim.deadlinePending >= pending);
  }

  /**
   * Drop claims already recorded on chain.
   *
   * This is what makes replay free: the collector keeps no progress across restarts and re-discovers the whole
   * claimable window on every start, so a batch that landed just before a restart comes back into the backlog.
   * `claimProverTips` reverts the whole tx on a repeated claim, so it must never reach a batch.
   */
  async #dropAlreadyClaimed(claims: PendingProverClaim[]): Promise<PendingProverClaim[]> {
    const checked = await Promise.all(
      claims.map(async claim => ({
        claim,
        claimed: await this.options.portal.claimed(claim.claim.rewardContext.epochNumber, claim.claim.leafId),
      })),
    );
    const claimed = checked.filter(entry => entry.claimed).map(entry => entry.claim);
    if (claimed.length > 0) {
      this.log.info(`Dropping ${claimed.length} prover claim(s) already claimed on chain`);
      this.options.backlog.resolve(claimed.map(entry => entry.id));
    }
    return checked.filter(entry => !entry.claimed).map(entry => entry.claim);
  }

  async #evaluatePortal(portal: ProverClaimPortalConfig, claims: PendingProverClaim[]): Promise<void> {
    const feeValues = await this.options.getFeeValues();
    if (isAboveMaxFeePerGas(this.options, feeValues.maxFeePerGas)) {
      // The claims stay backlogged for the next poll, or expire while the fee stays above the cap.
      const write = this.#aboveMaxFeePerGas ? this.log.debug : this.log.info;
      write.call(
        this.log,
        `Deferring ${claims.length} prover claim(s): max fee per gas ${feeValues.maxFeePerGas} is above the cap`,
      );
      this.#aboveMaxFeePerGas = true;
      return;
    }
    this.#aboveMaxFeePerGas = false;

    // Only the highest-tipped claims can make a batch, and assembly signs with the TEE, so bound the work to
    // what a single batch could carry.
    const shortlist = sortByTipDescending(claims, claim => claim.claim.rewardContext.tip).slice(0, MAX_ITEMS_PER_BATCH);
    const assembled = await this.#assemble(portal, shortlist);
    if (assembled.length === 0) {
      return;
    }

    const quote = this.#quoteFor(portal, feeValues.maxFeePerGas);

    // A claim whose tip does not cover its own marginal gas is left for a cheaper block rather than riding
    // along on the fat tips beside it.
    const { batch } = await selectProfitableBatch(assembled, quote, {
      tipOf: claim => claim.claim.rewardContext.tip,
      minProfit: this.options.minBatchProfit,
      profitOf: async (gas, reward) => reward - (await this.options.priceOracle.weiToUSD(gas * feeValues.maxFeePerGas)),
    });

    if (batch.length === 0) {
      // Nothing pays for itself at this price. The claims stay backlogged for the next poll, or expire trying.
      return;
    }

    await this.#publish(portal, batch, feeValues);
  }

  /** Assemble the claims that have no encoding yet. Cached on the backlog entry: assembly signs with the TEE. */
  async #assemble(portal: ProverClaimPortalConfig, claims: PendingProverClaim[]): Promise<PendingProverClaim[]> {
    const built = await Promise.all(claims.map(claim => this.#build(portal, claim)));
    const usable = built.filter((claim): claim is PendingProverClaim => claim !== undefined);
    this.options.backlog.update(usable);
    return usable;
  }

  /**
   * Build a claim's encoding, reusing the cached one. Returns undefined when the claim cannot be built, having
   * already retried or dropped it.
   */
  async #build(
    portal: ProverClaimPortalConfig,
    claim: PendingProverClaim,
    force = false,
  ): Promise<PendingProverClaim | undefined> {
    if (claim.assembled !== undefined && !force) {
      return claim;
    }
    try {
      const result = await portal.adaptor.buildProverClaimData(
        claim.claim.txRef,
        claim.claim.withdrawalIndex,
        claim.proofLength,
        portal.context,
      );
      if (result.status === 'error') {
        // The portal refuses this one for good (e.g. the burn is cut off by a freeze). Retrying cannot help.
        this.log.warn(`Dropping prover claim ${claim.id}: ${result.reason}`);
        this.options.backlog.resolve([claim.id]);
        return undefined;
      }
      return { ...claim, assembled: result.proverClaim };
    } catch (error) {
      // Anyone can publish a withdrawal log the signer refuses, so leave out just this claim and keep its
      // siblings. It stays backlogged and is retried on the next poll, until it succeeds or expires.
      this.log.warn(`Failed to build prover claim ${claim.id}, retrying on the next poll: ${error}`);
      return undefined;
    }
  }

  /**
   * Quote a batch the way the chain will price it: `estimateGas` for the tx gas, and a simulation at the same
   * price for the subsidy the prover subsidy pays out.
   */
  #quoteFor(
    portal: ProverClaimPortalConfig,
    maxFeePerGas: bigint,
  ): (subset: readonly PendingProverClaim[]) => Promise<{ totalGas: bigint; subsidy: bigint }> {
    const portalContract = this.options.portal.getContract();
    const account = this.options.senderAddress.toString();
    return async subset => {
      if (subset.length === 0) {
        return { totalGas: 0n, subsidy: 0n };
      }
      const args = [
        portal.context.proverSubsidy.toString(),
        subset.map(claim => toProverTipClaim(claim.assembled!)),
      ] as const;
      const totalGas = await portalContract.estimateGas.claimProverTips(args, { account });
      // A non-zero gas price makes the node check the sender's balance, so override it.
      const { result } = await portalContract.simulate.claimProverTips(args, {
        account,
        gasPrice: maxFeePerGas,
        stateOverride: [{ address: account, balance: maxUint256 }],
      });
      return { totalGas, subsidy: result };
    };
  }

  /**
   * Re-assemble the selected batch and send it.
   *
   * The cached encoding can be stale: assembly re-reads the portal's freeze, which caps a claim's proof length
   * and can rule the claim out entirely. Re-building here keeps that check next to the send. It does not move
   * the quote, because only the proof-length word can change and that does not alter the encoded size.
   */
  async #publish(
    portal: ProverClaimPortalConfig,
    batch: PendingProverClaim[],
    feeValues: FeeValuesEIP1559,
  ): Promise<void> {
    this.options.backlog.update(batch.map(claim => ({ ...claim, status: 'publishing' as const })));

    const rebuilt = await Promise.all(batch.map(claim => this.#build(portal, claim, /* force */ true)));
    if (rebuilt.some(claim => claim === undefined)) {
      // One claim fell away between selection and send. Release the whole batch — a claim left 'publishing' would
      // hold isPublishing true and block this portal's polling forever. A transiently-failed claim goes back under
      // its original entry; one the rebuild dropped for good is already resolved, and update skips it.
      const released = rebuilt.map((claim, i) => claim ?? batch[i]);
      this.log.warn('Aborting prover claim batch: a claim stopped being buildable after it was selected');
      this.options.backlog.update(released.map(claim => ({ ...claim, status: 'pending' as const })));
      return;
    }

    const claims = rebuilt as PendingProverClaim[];
    const ids = claims.map(claim => claim.id);
    try {
      const { confirmed } = await this.options.publisher.publish(
        portal,
        claims.map(claim => claim.assembled as ProverClaim),
        feeValues,
      );
      await confirmed;
      this.options.backlog.resolve(ids);
    } catch (error) {
      // Return them to the backlog. A reverted or reorged batch must not cost the tips: the next poll re-prices
      // them, and `dropAlreadyClaimed` covers the case where the tx did land after all.
      this.log.error(`Prover claim batch failed, returning ${ids.length} claim(s) to the backlog: ${error}`);
      this.options.backlog.update(claims.map(claim => ({ ...claim, status: 'pending' as const })));
    }
  }
}
