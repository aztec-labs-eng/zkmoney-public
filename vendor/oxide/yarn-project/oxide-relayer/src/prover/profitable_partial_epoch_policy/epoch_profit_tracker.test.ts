import { CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { EthAddress } from '@aztec/foundation/eth-address';
import { Checkpoint } from '@aztec/stdlib/checkpoint';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { PriceOracle, TokenPrice } from '../../price_oracle/price_oracle.js';
import { portalId } from '../types.js';
import { EpochProfitTracker, EpochProfitTrackerOptions } from './epoch_profit_tracker.js';
import { DiscoveredClaim, EarlySubmitPortalConfig } from './types.js';

describe('EpochProfitTracker', () => {
  const l1Portal = EthAddress.random();
  const token = EthAddress.random();
  let discover: jest.Mock<() => Promise<DiscoveredClaim[]>>;
  // Checkpoint -> L1 block the first-prover record landed in; absent means uncovered. Mutated per test to model
  // reorgs and fresh captures.
  let covered: Map<number, bigint>;

  // A single claim on portal `p`; only `rewardContext.tip` is priced. Its checkpoint sits above the (zero) covered
  // watermark so it survives filtering.
  const claimFor = (p: EarlySubmitPortalConfig, tip = REWARD): DiscoveredClaim =>
    ({
      portalId: portalId(p.context.l1Portal),
      checkpointNumber: CheckpointNumber(1),
      rewardContext: { tip } as any,
      txRef: {} as any,
      withdrawalIndex: 0,
      leafId: 1n,
    }) as DiscoveredClaim;

  // A claim on the shared portal.
  const claim = (tip: bigint): DiscoveredClaim => claimFor(portal, tip);

  // A portal of its own, for the cases with more than one portal.
  const makePortal = (
    quoteProverSubsidy: EarlySubmitPortalConfig['quoteProverSubsidy'] = () => Promise.resolve(0n),
    portalToken = token,
  ): EarlySubmitPortalConfig =>
    ({
      context: {
        l1Portal: EthAddress.random(),
        token: portalToken,
        l2Portal: undefined,
        proverSubsidy: EthAddress.random(),
      },
      adaptor: {},
      quoteProverSubsidy,
    }) as unknown as EarlySubmitPortalConfig;

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

  /** How many times the tracker read the ETH price and a token price. */
  let ethPriceReads: number;
  let tokenPriceReads: number;

  /** An oracle that prices ETH at `ETH_USD_RATE` and gives each token in `prices` its own price. */
  const oracleWith = (prices: ReadonlyMap<string, TokenPrice> = new Map()): PriceOracle =>
    ({
      getEthPrice: () => {
        ethPriceReads++;
        return Promise.resolve(usd(ETH_USD_RATE));
      },
      // An 18-decimal token worth one USD, unless the test prices it otherwise.
      getTokenPrice: (rewardToken: EthAddress) => {
        tokenPriceReads++;
        return Promise.resolve(prices.get(rewardToken.toString()) ?? { usdPerToken: usd(1n), decimals: 18 });
      },
    }) satisfies PriceOracle;

  const getEffectiveGasPriceWei = () => Promise.resolve(GAS_PRICE_WEI);
  // The claim batch submitter prices a batch at a max fee per gas above the effective price.
  const CLAIM_MAX_FEE_PER_GAS_WEI = 2n * GAS_PRICE_WEI;
  const getClaimMaxFeePerGasWei = () => Promise.resolve(CLAIM_MAX_FEE_PER_GAS_WEI);

  // A flat proof model, so the prefix length changes nothing but the proving cost in these tests.
  const EPOCH_GAS_MODEL = { baseGas: 640_000n, gasPerCheckpoint: 0n };
  const EPOCH_GAS = EPOCH_GAS_MODEL.baseGas;
  // Most cases leave the claim transactions out, so their figures are the proof submission alone. The claim-gas
  // cases set a model of their own.
  const NO_CLAIM_GAS_MODEL = { baseGas: 0n, gasPerClaim: 0n };
  // 10_000 gas for each claim transaction and 5_000 for each claim in it.
  const CLAIM_GAS_MODEL = { baseGas: 10_000n, gasPerClaim: 5_000n };
  // Most cases leave the extra first-prover captures out. The capture-gas case sets a figure of its own.
  const NO_CAPTURE_GAS = 0n;

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

  const makeTracker = (
    provingCostPerCheckpoint: bigint,
    submitEpochProofGasModel = EPOCH_GAS_MODEL,
    claimProverTipsGasModel = NO_CLAIM_GAS_MODEL,
    portals = [portal],
    firstProverCaptureGas = NO_CAPTURE_GAS,
    priceOracle = oracleWith(),
    maxFeePerGasCap?: bigint,
  ) =>
    new EpochProfitTracker({
      discoverer: { discover } as any,
      portal: portalContract,
      portals,
      priceOracle,
      getEffectiveGasPriceWei,
      getClaimMaxFeePerGasWei,
      maxFeePerGasCap,
      submitEpochProofGasModel,
      claimProverTipsGasModel,
      firstProverCaptureGas,
      minEpochProfit: 0n,
      minEpochProfitMarginBps: 0n,
      provingCostPerCheckpoint,
      minClaimBatchProfit: 0n,
    } satisfies EpochProfitTrackerOptions);

  beforeEach(() => {
    covered = new Map();
    quotedClaimCounts = [];
    ethPriceReads = 0;
    tokenPriceReads = 0;
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

  it('charges the epoch for the proof submission gas', async () => {
    const decision = await makeTracker(0n).evaluate(EpochNumber(1), checkpoints(1));
    expect(decision.details?.totalGas).toBe(EPOCH_GAS);
    expect(decision.details?.totalGasCostValue).toBe(EPOCH_GAS_COST);
  });

  it('charges the claim transaction that collects the tips', async () => {
    discover.mockImplementation(() => Promise.resolve([claim(REWARD), claim(REWARD)]));
    const decision = await makeTracker(0n, EPOCH_GAS_MODEL, CLAIM_GAS_MODEL).evaluate(EpochNumber(1), checkpoints(1));
    // One transaction with two claims: 10_000 + 2 * 5_000 gas on top of the proof's 640_000.
    expect(decision.details?.totalGas).toBe(EPOCH_GAS + 20_000n);
    // 660_000 gas at 1 gwei and 2_000 USD per ETH.
    expect(decision.details?.totalGasCostValue).toBe(usd(1n, 32n));
  });

  it('prices the proof submission for the length of the prefix', async () => {
    // 600_000 gas plus 40_000 per checkpoint: a 2-checkpoint prefix pays 680_000 gas, or 1.36 USD.
    const tracker = makeTracker(0n, { baseGas: 600_000n, gasPerCheckpoint: 40_000n });
    const decision = await tracker.evaluate(EpochNumber(1), checkpoints(2));
    expect(decision.details?.totalGas).toBe(680_000n);
    expect(decision.details?.totalGasCostValue).toBe(usd(1n, 36n));
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
    const healthy = makePortal();
    const broken = makePortal(() => Promise.reject(new Error('WrongPortal')));
    discover.mockImplementation(() => Promise.resolve([claimFor(healthy), claimFor(broken)]));

    const tracker = makeTracker(0n, EPOCH_GAS_MODEL, CLAIM_GAS_MODEL, [healthy, broken]);
    const decision = await tracker.evaluate(EpochNumber(1), checkpoints(2));

    expect(decision.submit).toBe(true);
    expect(decision.details?.claimCount).toBe(1);
    // Only the healthy portal sends a claim transaction: 10_000 + 5_000 gas.
    expect(decision.details?.totalGas).toBe(EPOCH_GAS + 15_000n);
  });

  it('values each portal reward in the token of that portal', async () => {
    const vaultToken = EthAddress.random();
    const stable = makePortal();
    const vault = makePortal(undefined, vaultToken);
    discover.mockImplementation(() => Promise.resolve([claimFor(stable), claimFor(vault)]));
    // One share of the vault is worth 1.05 USD, as an sUSDS share is worth more than the USDS it converts to.
    const prices = new Map([[vaultToken.toString(), { usdPerToken: usd(1n, 5n), decimals: 18 }]]);

    const tracker = makeTracker(
      0n,
      EPOCH_GAS_MODEL,
      NO_CLAIM_GAS_MODEL,
      [stable, vault],
      NO_CAPTURE_GAS,
      oracleWith(prices),
    );
    const decision = await tracker.evaluate(EpochNumber(1), checkpoints(1));

    // 100.00 of the stable token and 100 shares worth 105.00.
    expect(decision.details?.totalRewardValue).toBe(usd(205n));
  });

  it('charges one claim transaction for each portal that has claims', async () => {
    const first = makePortal();
    const second = makePortal();
    const idle = makePortal();
    discover.mockImplementation(() => Promise.resolve([claimFor(first), claimFor(first), claimFor(second)]));

    const tracker = makeTracker(0n, EPOCH_GAS_MODEL, CLAIM_GAS_MODEL, [first, second, idle]);
    const decision = await tracker.evaluate(EpochNumber(1), checkpoints(1));

    // Two claims on the first portal (10_000 + 2 * 5_000) and one on the second (10_000 + 5_000). The idle portal
    // has no claims, so it sends no transaction.
    expect(decision.details?.totalGas).toBe(EPOCH_GAS + 35_000n);
    expect(decision.details?.claimCount).toBe(3);
  });

  it('charges a first-prover capture for each portal, with claims or not', async () => {
    const first = makePortal();
    discover.mockImplementation(() => Promise.resolve([claimFor(first)]));

    const tracker = makeTracker(0n, EPOCH_GAS_MODEL, NO_CLAIM_GAS_MODEL, [first, makePortal(), makePortal()], 50_000n);
    const decision = await tracker.evaluate(EpochNumber(1), checkpoints(1));

    // The proof records a capture on each of the three portals.
    expect(decision.details?.totalGas).toBe(EPOCH_GAS + 3n * 50_000n);
  });

  it('submits when the rewards of all portals together pay for the proof, but no portal alone does', async () => {
    // Each portal quotes its own subsidy. Portal A pays 0.50 + 0.30 and portal B pays 0.40 + 0.20. Each is below
    // the 1.28 gas cost of the proof, but together they pay 1.40.
    const a = makePortal(() => Promise.resolve(usd(0n, 30n)));
    const b = makePortal(() => Promise.resolve(usd(0n, 20n)));
    const claimOnA = claimFor(a, usd(0n, 50n));
    const claimOnB = claimFor(b, usd(0n, 40n));

    const evaluate = (claims: DiscoveredClaim[]) => {
      discover.mockImplementation(() => Promise.resolve(claims));
      return makeTracker(0n, EPOCH_GAS_MODEL, NO_CLAIM_GAS_MODEL, [a, b]).evaluate(EpochNumber(1), checkpoints(1));
    };

    await expect(evaluate([claimOnA])).resolves.toMatchObject({ submit: false });
    await expect(evaluate([claimOnB])).resolves.toMatchObject({ submit: false });

    const decision = await evaluate([claimOnA, claimOnB]);
    expect(decision.submit).toBe(true);
    expect(decision.details?.totalRewardValue).toBe(usd(1n, 40n));
    expect(decision.details?.profit).toBe(usd(0n, 12n));
  });

  describe('claims that the batch submitter will not send', () => {
    // 1.5 cents. With CLAIM_GAS_MODEL, a claim costs 5_000 gas: 1 cent at the effective 1 gwei, 2 cents at the
    // 2 gwei max fee. So the tip pays for the claim at the effective price, but the submitter leaves it out.
    const LOW_TIP = 15n * 10n ** 15n;

    it('leaves out a claim whose tip does not pay for its gas at the max fee per gas', async () => {
      discover.mockImplementation(() => Promise.resolve([claim(LOW_TIP), claim(REWARD)]));
      const decision = await makeTracker(0n, EPOCH_GAS_MODEL, CLAIM_GAS_MODEL).evaluate(EpochNumber(1), checkpoints(1));

      expect(decision.details?.claimCount).toBe(1);
      expect(decision.details?.totalRewardValue).toBe(REWARD);
      // One transaction with the one claim: 10_000 + 5_000 gas on top of the proof's 640_000.
      expect(decision.details?.totalGas).toBe(EPOCH_GAS + 15_000n);
      // The tracker charges the gas of the claims it counts at the effective price, not at the max fee:
      // 655_000 gas at 1 gwei and 2_000 USD per ETH.
      expect(decision.details?.totalGasCostValue).toBe(usd(1n, 31n));
    });

    it('rejects a proof that only a claim the submitter will not send makes profitable', async () => {
      discover.mockImplementation(() => Promise.resolve([claim(LOW_TIP), claim(REWARD)]));
      // Without the low-tip claim: 100.00 reward − 1.31 gas − proving cost = −0.005. With it, the low tip adds
      // 1.5 cents for 1 cent of gas, and the profit would be 0.
      const provingCost = REWARD - usd(1n, 31n) + 5n * 10n ** 15n;
      const decision = await makeTracker(provingCost, EPOCH_GAS_MODEL, CLAIM_GAS_MODEL).evaluate(
        EpochNumber(1),
        checkpoints(1),
      );

      expect(decision.submit).toBe(false);
      expect(decision.details?.profit).toBe(-5n * 10n ** 15n);
    });

    it('keeps a claim whose subsidy pays for its gas at the max fee per gas', async () => {
      // 5 cents of subsidy for each claim pays for the 2 cents of gas of a claim with no tip.
      const subsidized = makePortal(numClaims => Promise.resolve(numClaims * usd(0n, 5n)));
      discover.mockImplementation(() => Promise.resolve([claimFor(subsidized), claimFor(subsidized, 0n)]));

      const tracker = makeTracker(0n, EPOCH_GAS_MODEL, CLAIM_GAS_MODEL, [subsidized]);
      const decision = await tracker.evaluate(EpochNumber(1), checkpoints(1));

      expect(decision.details?.claimCount).toBe(2);
      expect(decision.details?.totalRewardValue).toBe(REWARD + usd(0n, 10n));
    });

    it('declines a proof when the submitter will send none of its claims', async () => {
      // A 2-cent tip against 6 cents of claim gas at the max fee: 10_000 + 5_000 gas at 2 gwei.
      discover.mockImplementation(() => Promise.resolve([claim(usd(0n, 2n))]));
      const decision = await makeTracker(0n, EPOCH_GAS_MODEL, CLAIM_GAS_MODEL).evaluate(EpochNumber(1), checkpoints(1));

      expect(decision.submit).toBe(false);
      expect(decision.details?.claimCount).toBe(0);
      expect(decision.details?.totalRewardValue).toBe(0n);
    });

    it('declines a proof without pricing it while the max fee per gas is above the cap', async () => {
      const tracker = makeTracker(
        0n,
        EPOCH_GAS_MODEL,
        CLAIM_GAS_MODEL,
        [portal],
        NO_CAPTURE_GAS,
        oracleWith(),
        CLAIM_MAX_FEE_PER_GAS_WEI - 1n,
      );
      const decision = await tracker.evaluate(EpochNumber(1), checkpoints(1));

      expect(decision).toEqual({ submit: false, reason: 'max fee per gas above the cap' });
      expect(quotedClaimCounts).toEqual([]);
    });

    it('submits a proof when the max fee per gas is at the cap', async () => {
      const tracker = makeTracker(
        0n,
        EPOCH_GAS_MODEL,
        CLAIM_GAS_MODEL,
        [portal],
        NO_CAPTURE_GAS,
        oracleWith(),
        CLAIM_MAX_FEE_PER_GAS_WEI,
      );
      const decision = await tracker.evaluate(EpochNumber(1), checkpoints(1));

      expect(decision.submit).toBe(true);
    });
  });

  it('counts only the claims of the first batch', async () => {
    // Every claim pays for its gas, but a batch carries at most 100 claims (MAX_ITEMS_PER_BATCH).
    discover.mockImplementation(() => Promise.resolve(Array.from({ length: 150 }, () => claim(usd(1n)))));

    const tracker = makeTracker(0n, EPOCH_GAS_MODEL, CLAIM_GAS_MODEL);
    const decision = await tracker.evaluate(EpochNumber(1), checkpoints(1));

    expect(decision.details?.claimCount).toBe(100);
    expect(decision.details?.totalRewardValue).toBe(usd(100n));
  });

  it('reads the ETH price and the token price once for each evaluation', async () => {
    // No claim pays for its gas, so the selection prices every candidate batch from 100 claims down to 0.
    discover.mockImplementation(() => Promise.resolve(Array.from({ length: 100 }, () => claim(0n))));

    const tracker = makeTracker(0n, EPOCH_GAS_MODEL, CLAIM_GAS_MODEL);
    const decision = await tracker.evaluate(EpochNumber(1), checkpoints(1));

    expect(decision.details?.claimCount).toBe(0);
    expect(ethPriceReads).toBe(1);
    expect(tokenPriceReads).toBe(1);
  });
});
