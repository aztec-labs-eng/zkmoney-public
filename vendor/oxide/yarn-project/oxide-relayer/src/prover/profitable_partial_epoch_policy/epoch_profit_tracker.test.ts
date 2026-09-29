import { CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { EthAddress } from '@aztec/foundation/eth-address';
import { Checkpoint } from '@aztec/stdlib/checkpoint';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ChainlinkPriceOracle } from '../../price_oracle/chainlink_price_oracle.js';
import { portalId } from '../types.js';
import { ROLLUP__SUBMIT_EPOCH_PROOF_GAS } from './config.js';
import { EpochProfitTracker, EpochProfitTrackerOptions } from './epoch_profit_tracker.js';
import { DiscoveredClaim, EarlySubmitPortalConfig } from './types.js';

describe('EpochProfitTracker', () => {
  const l1Portal = EthAddress.random();
  const token = EthAddress.random();
  let discover: jest.Mock<() => Promise<DiscoveredClaim[]>>;
  // Checkpoint -> L1 block the first-prover record landed in; absent means uncovered. Mutated per test to model
  // reorgs and fresh captures.
  let covered: Map<number, bigint>;

  // A single claim with a fixed tip; only `rewardContext.tip` is priced. Its checkpoint sits above the (zero)
  // covered watermark so it survives filtering.
  const claim = (tip: bigint): DiscoveredClaim =>
    ({
      portalId: portalId(l1Portal),
      checkpointNumber: CheckpointNumber(1),
      rewardContext: { tip } as any,
      txRef: {} as any,
      withdrawalIndex: 0,
      leafId: 1n,
    }) as DiscoveredClaim;

  // `fork` distinguishes content: the same checkpoint numbers on a different fork carry different archive roots,
  // as after a reorg.
  const checkpoints = (count: number, fork = 'a'): Checkpoint[] =>
    Array.from(
      { length: count },
      (_, i) => ({ number: CheckpointNumber(i + 1), archive: { root: `0x${fork}${i + 1}` } }) as unknown as Checkpoint,
    );

  /** Every claim count the tracker asked the flat-subsidy quote for, in call order. */
  let quotedClaimCounts: bigint[];

  const portal = {
    context: { l1Portal, token, l2Portal: undefined, proverSubsidy: EthAddress.random() },
    adaptor: {},
    quoteProverSubsidy: (numClaims: bigint) => {
      quotedClaimCounts.push(numClaims);
      return Promise.resolve(0n);
    },
  } as unknown as EarlySubmitPortalConfig;

  // Mainnet-scale pricing: 1 gwei of L1 gas and 2_000 USD per ETH.
  const GAS_PRICE_WEI = 10n ** 9n;
  const ETH_USD_RATE = 2_000n;

  /** 18-decimal USD from dollars and cents, the scale of the Portal's USD-pegged underlying. */
  const usd = (dollars: bigint, cents = 0n): bigint => dollars * 10n ** 18n + cents * 10n ** 16n;

  // 10^18 wei is one ETH, which is `ETH_USD_RATE` dollars, or `ETH_USD_RATE * 10^18` in the 18-decimal quote
  // currency. The 10^18 cancels, so the rate alone converts wei to the quote scale.
  const priceOracle = {
    weiToUSD: (wei: bigint) => Promise.resolve(wei * ETH_USD_RATE),
  } as unknown as ChainlinkPriceOracle;

  const getEffectiveGasPriceWei = () => Promise.resolve(GAS_PRICE_WEI);

  // The gas an epoch pays for is the proof submission alone; the claim batch's gas is not part of the cost.
  const EPOCH_GAS = ROLLUP__SUBMIT_EPOCH_PROOF_GAS;

  // The same gas, priced through the rates above: 640_000 gas at 1 gwei is 0.00064 ETH, or 1.28 USD at 2_000 USD
  // per ETH.
  const EPOCH_GAS_COST = usd(1n, 28n);
  // The tip on the discovered withdrawal, the only income. It is far above the gas to capture it, so the prefix
  // is profitable until an off-chain proving cost is charged.
  const REWARD = usd(100n);
  // 100.00 reward − 1.28 gas. The proving cost is not subtracted yet: it is off-chain and configured, not derived
  // from the chain, and each test sets its own.
  const PROFIT_BEFORE_PROVING = usd(98n, 72n);

  // Serves `firstProver` from `covered`, honoring the pinned read block: a record is visible only at or after
  // the block it landed in.
  const HEAD = 1_000n;
  const portalContract = {
    client: { getBlockNumber: () => Promise.resolve(HEAD) },
    firstProver: (checkpointNumber: CheckpointNumber, { blockNumber }: { blockNumber: bigint }) => {
      const recordedAt = covered.get(Number(checkpointNumber));
      return Promise.resolve(
        recordedAt !== undefined && recordedAt <= blockNumber ? EthAddress.random() : EthAddress.ZERO,
      );
    },
  } as any;

  const makeTracker = (provingCostPerCheckpoint: bigint) =>
    new EpochProfitTracker({
      discoverer: { discover } as any,
      portal: portalContract,
      portals: [portal],
      priceOracle,
      getEffectiveGasPriceWei,
      rollupSubmitEpochProofGas: ROLLUP__SUBMIT_EPOCH_PROOF_GAS,
      minEpochProfit: 0n,
      minEpochProfitMarginBps: 0n,
      provingCostPerCheckpoint,
    } satisfies EpochProfitTrackerOptions);

  beforeEach(() => {
    covered = new Map();
    quotedClaimCounts = [];
    discover = jest.fn(() => Promise.resolve([claim(REWARD)]));
  });

  it('submits a profitable prefix when proving cost is zero', async () => {
    const decision = await makeTracker(0n).evaluate(EpochNumber(1), checkpoints(1));
    expect(decision.submit).toBe(true);
    expect(decision.details?.provingCostValue).toBe(0n);
    expect(decision.details?.profit).toBe(PROFIT_BEFORE_PROVING);
    // The prover subsidy is asked for its flat quote for the one discovered claim.
    expect(quotedClaimCounts).toEqual([1n]);
  });

  it('charges the epoch for the proof submission gas only', async () => {
    const decision = await makeTracker(0n).evaluate(EpochNumber(1), checkpoints(1));
    expect(decision.details?.totalGas).toBe(EPOCH_GAS);
    expect(decision.details?.totalGasCostValue).toBe(EPOCH_GAS_COST);
  });

  it('rejects the same prefix once the proving cost outweighs the profit', async () => {
    // 110.00 to prove one checkpoint against 98.72 of profit leaves the epoch 11.28 short.
    const decision = await makeTracker(usd(110n)).evaluate(EpochNumber(1), checkpoints(1));
    expect(decision.submit).toBe(false);
    expect(decision.details?.provingCostValue).toBe(usd(110n));
    expect(decision.details?.profit).toBe(-usd(11n, 28n));
  });

  it('scales the proving cost with prefix length, rejecting a longer prefix with no extra claims', async () => {
    // 40.00 per checkpoint: a 2-checkpoint prefix still clears (98.72 − 80.00), a 3-checkpoint one does not.
    const short = await makeTracker(usd(40n)).evaluate(EpochNumber(1), checkpoints(2));
    expect(short.submit).toBe(true);
    expect(short.details?.provingCostValue).toBe(usd(80n));
    expect(short.details?.profit).toBe(usd(18n, 72n));

    const long = await makeTracker(usd(40n)).evaluate(EpochNumber(2), checkpoints(3));
    expect(long.submit).toBe(false);
    expect(long.details?.provingCostValue).toBe(usd(120n));
    expect(long.details?.profit).toBe(-usd(21n, 28n));
  });

  it('declines a prefix with no tipped withdrawals without pricing it', async () => {
    discover.mockImplementation(() => Promise.resolve([]));
    const decision = await makeTracker(0n).evaluate(EpochNumber(1), checkpoints(1));
    expect(decision.submit).toBe(false);
    expect(decision.reason).toBe('no claimable tips');
  });

  it('excludes a claim whose checkpoint an on-chain first prover already covers', async () => {
    covered.set(1, 900n);
    const decision = await makeTracker(0n).evaluate(EpochNumber(1), checkpoints(1));
    expect(decision.submit).toBe(false);
    expect(decision.reason).toBe('no claimable tips');
  });

  it('respects a first-prover record landed in the newest head block', async () => {
    // A capture in the head block itself must suppress submission: lagging the read behind the head would spend
    // proving compute on an already-captured prefix.
    covered.set(1, HEAD);
    const decision = await makeTracker(0n).evaluate(EpochNumber(1), checkpoints(1));
    expect(decision.submit).toBe(false);
    expect(decision.reason).toBe('no claimable tips');
  });

  it('rediscovers instead of serving cached claims when a reorg replaced checkpoint content', async () => {
    const tracker = makeTracker(0n);
    const first = await tracker.evaluate(EpochNumber(1), checkpoints(1));
    expect(first.details?.profit).toBe(PROFIT_BEFORE_PROVING);

    // A reorg replaces the epoch's content under the same checkpoint numbers. The tracker gets no external
    // signal; the archive-root check alone must retire the cached claims and rediscover the entire delivered
    // prefix from the new content.
    discover.mockImplementation(() => Promise.resolve([claim(usd(50n))]));
    const afterReorg = await tracker.evaluate(EpochNumber(1), checkpoints(2, 'b'));

    expect(discover).toHaveBeenCalledTimes(2);
    expect((discover.mock.calls[1] as unknown[])[1]).toHaveLength(2); // both checkpoints rediscovered
    // 50.00 reward − 1.28 gas: the stale 100.00 claim is gone from the estimate.
    expect(afterReorg.details?.profit).toBe(usd(48n, 72n));
  });

  it('re-includes the claim once a reorg drops the first-prover coverage', async () => {
    const tracker = makeTracker(0n);

    // First-prover coverage suppresses the only claim, so the prefix looks unprofitable.
    covered.set(1, 900n);
    const suppressed = await tracker.evaluate(EpochNumber(1), checkpoints(1));
    expect(suppressed.submit).toBe(false);

    // An L1 reorg drops the FirstProverRecorded event without touching the checkpoints themselves. The next
    // evaluation must re-read coverage and re-expose the cached claim rather than stay suppressed.
    covered.delete(1);
    const restored = await tracker.evaluate(EpochNumber(1), checkpoints(1));
    expect(restored.submit).toBe(true);
    expect(restored.details?.profit).toBe(PROFIT_BEFORE_PROVING);
    // The claim was discovered during the suppressed evaluation and served from cache here, not rediscovered.
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('excludes a portal whose subsidy quote fails; the others still price and submit', async () => {
    const makePortal = (quoteProverSubsidy: () => Promise<bigint>): EarlySubmitPortalConfig =>
      ({
        context: { l1Portal: EthAddress.random(), token, l2Portal: undefined, proverSubsidy: EthAddress.random() },
        adaptor: {},
        quoteProverSubsidy,
      }) as unknown as EarlySubmitPortalConfig;

    const claimFor = (p: EarlySubmitPortalConfig, tip: bigint): DiscoveredClaim =>
      ({
        portalId: portalId(p.context.l1Portal),
        checkpointNumber: CheckpointNumber(1),
        rewardContext: { tip } as any,
        txRef: {} as any,
        withdrawalIndex: 0,
        leafId: 1n,
      }) as DiscoveredClaim;

    const healthy = makePortal(() => Promise.resolve(0n));
    const broken = makePortal(() => Promise.reject(new Error('WrongPortal')));
    const claims = [claimFor(healthy, REWARD), claimFor(broken, REWARD)];

    const tracker = new EpochProfitTracker({
      discoverer: { discover: () => Promise.resolve(claims) } as any,
      portal: portalContract,
      portals: [healthy, broken],
      priceOracle,
      getEffectiveGasPriceWei,
      rollupSubmitEpochProofGas: ROLLUP__SUBMIT_EPOCH_PROOF_GAS,
      minEpochProfit: 0n,
      minEpochProfitMarginBps: 0n,
      provingCostPerCheckpoint: 0n,
    } satisfies EpochProfitTrackerOptions);

    const decision = await tracker.evaluate(EpochNumber(1), checkpoints(2));

    expect(decision.submit).toBe(true);
    expect(decision.details?.claimCount).toBe(1);
  });
});
