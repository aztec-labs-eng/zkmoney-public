import { BlockNumber, CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';
import { TxHash } from '@aztec/stdlib/tx';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { PriceOracle } from '../../price_oracle/price_oracle.js';
import { DiscoveredClaim } from '../prover_claim_lib/index.js';
import { portalId } from '../types.js';
import {
  ProfitableClaimBatchSubmitter,
  ProfitableClaimBatchSubmitterOptions,
} from './profitable_claim_batch_submitter.js';
import { ProverClaimBacklog, claimId } from './prover_claim_backlog.js';

// Fake gas model: a batch costs FIXED plus PER_CLAIM for each claim. With an identity price oracle and a gas
// price of `gasPriceWei`, profit is simply `tips - gas * gasPriceWei`.
const FIXED_GAS = 50n;
const PER_CLAIM_GAS = 100n;

/** One whole USD at the 18 decimals every price is in. */
const ONE_USD = 10n ** 18n;

/** An oracle that prices one ETH and one whole 18-decimal token at `usd` each. */
const oracleAt = (usd: bigint): PriceOracle => ({
  getEthPrice: () => Promise.resolve(usd),
  getTokenPrice: () => Promise.resolve({ usdPerToken: usd, decimals: 18 }),
});

const L1_PORTAL = EthAddress.random();
const TOKEN = EthAddress.random();
const PORTAL_ID = portalId(L1_PORTAL);
const SENDER = EthAddress.random();

// Structurally valid claim: it goes through toProverTipClaim on the way to the quote.
const proverClaim = () => ({
  claimArgs: {
    content: { executor: EthAddress.random(), userPayloadHash: Fr.random(), amount: 1n, proverTip: 1n, randomness: 0n },
    checkpointNumber: CheckpointNumber(10),
    withdrawalId: '0x'.padEnd(66, '0'),
    teeSignature: '0x',
  },
  epochNumber: EpochNumber(1),
  messageLeafIndex: 0n,
  path: [],
  proofLength: 3n,
  checkpointNumber: CheckpointNumber(10),
});

const discovered = (withdrawalIndex: number, tip: bigint): DiscoveredClaim => ({
  portalId: PORTAL_ID,
  checkpointNumber: CheckpointNumber(10),
  rewardContext: {
    epochNumber: EpochNumber(1),
    messageLeafIndex: BigInt(withdrawalIndex),
    pathLength: 7n,
    tip,
  },
  txRef: {
    epochNumber: EpochNumber(1),
    checkpointNumber: CheckpointNumber(10),
    blockNumber: BlockNumber(10),
    txHash: TxHash.random(),
  },
  withdrawalIndex,
  leafId: BigInt(128 + withdrawalIndex),
});

describe('ProfitableClaimBatchSubmitter', () => {
  let backlog: ProverClaimBacklog;
  let gasPriceWei: bigint;
  let pendingCheckpoint: number;
  let claimedLeaves: Set<string>;
  let buildProverClaimData: jest.Mock<(...args: any[]) => Promise<any>>;
  let publish: jest.Mock<(...args: any[]) => Promise<{ confirmed: Promise<void> }>>;
  let estimateGas: jest.Mock<(...args: any[]) => Promise<bigint>>;

  const seed = (claims: DiscoveredClaim[], deadlinePending = 100) => {
    backlog.add(
      claims.map(claim => ({
        id: claimId(claim),
        portalId: claim.portalId,
        claim,
        proofLength: 3n,
        deadlinePending: CheckpointNumber(deadlinePending),
      })),
    );
  };

  const build = (overrides: Partial<ProfitableClaimBatchSubmitterOptions> = {}) => {
    const portalContract = {
      claimed: (_epoch: EpochNumber, leafId: bigint) => Promise.resolve(claimedLeaves.has(leafId.toString())),
      getContract: () => ({
        estimateGas: { claimProverTips: (...args: any[]) => estimateGas(...args) },
        simulate: { claimProverTips: () => Promise.resolve({ result: 0n }) },
      }),
    } as any;
    const portal = {
      context: { l1Portal: L1_PORTAL, token: TOKEN, proverSubsidy: EthAddress.random() },
      adaptor: { buildProverClaimData: (...args: any[]) => buildProverClaimData(...args) },
      contract: portalContract,
    } as any;
    return new ProfitableClaimBatchSubmitter({
      rollup: { getCheckpointNumber: () => Promise.resolve(CheckpointNumber(pendingCheckpoint)) } as any,
      portals: [portal],
      backlog,
      // One USD per ETH and per token, so profit reduces to tips minus gas cost.
      priceOracle: oracleAt(ONE_USD),
      getFeeValues: () => Promise.resolve({ maxFeePerGas: gasPriceWei, maxPriorityFeePerGas: 0n }),
      publisher: { publish: (...args: any[]) => publish(...args) } as any,
      senderAddress: SENDER,
      minBatchProfit: 0n,
      intervalMs: 1_000_000, // Never self-polls; every test drives pollPortal by hand.
      ...overrides,
    });
  };

  beforeEach(() => {
    backlog = new ProverClaimBacklog();
    gasPriceWei = 1n;
    pendingCheckpoint = 20;
    claimedLeaves = new Set();
    buildProverClaimData = jest.fn(() => Promise.resolve({ status: 'success', proverClaim: proverClaim() }));
    publish = jest.fn(() => Promise.resolve({ confirmed: Promise.resolve() }));
    estimateGas = jest.fn((args: any) => Promise.resolve(FIXED_GAS + PER_CLAIM_GAS * BigInt(args[1].length)));
  });

  it('drops a claim past its deadline and never submits it', async () => {
    seed([discovered(0, 10_000n)], /* deadlinePending */ 19);
    pendingCheckpoint = 20; // one past the deadline

    await build().pollPortal(PORTAL_ID);

    expect(publish).not.toHaveBeenCalled();
    expect(backlog.getPortalClaims(PORTAL_ID)).toHaveLength(0);
  });

  it('keeps a claim that does not pay yet and publishes it on a later poll once gas falls', async () => {
    // One claim tipping 200. A single-claim batch burns 150 gas, so it loses at 2 wei/gas and wins at 1.
    seed([discovered(0, 200n)]);
    const submitter = build();

    gasPriceWei = 2n;
    await submitter.pollPortal(PORTAL_ID);
    expect(publish).not.toHaveBeenCalled();
    // Still backlogged: an unaffordable claim must not be thrown away.
    expect(backlog.getPortalClaims(PORTAL_ID)).toHaveLength(1);

    gasPriceWei = 1n;
    await submitter.pollPortal(PORTAL_ID);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(backlog.getPortalClaims(PORTAL_ID)).toHaveLength(0);
  });

  it('values the reward in the portal token before it compares it with the gas', async () => {
    // One claim tipping 200 against 150 gas at 2 wei: at one USD a token it loses 100, at two USD a share it wins 100.
    seed([discovered(0, 200n)]);
    gasPriceWei = 2n;
    const getTokenPrice = jest.fn((_token: EthAddress) => Promise.resolve({ usdPerToken: 2n * ONE_USD, decimals: 18 }));

    await build({ priceOracle: { ...oracleAt(ONE_USD), getTokenPrice } }).pollPortal(PORTAL_ID);

    expect(publish).toHaveBeenCalledTimes(1);
    // The reward is priced in the token of the portal being polled, not in some default token.
    expect(getTokenPrice.mock.calls.every(([token]) => token.equals(TOKEN))).toBe(true);
  });

  it('keeps the claims backlogged while the max fee per gas is above the cap, and publishes once it falls', async () => {
    seed([discovered(0, 10_000n)]);
    gasPriceWei = 2n;
    const submitter = build({ maxFeePerGasCap: 1n });

    await submitter.pollPortal(PORTAL_ID);
    expect(buildProverClaimData).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(backlog.getPortalClaims(PORTAL_ID)).toHaveLength(1);

    gasPriceWei = 1n;
    await submitter.pollPortal(PORTAL_ID);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('leaves out a claim whose own tip does not cover its own marginal gas', async () => {
    // Both together: gas 250, tips 510, profit 260. The fat claim alone: gas 150, tip 500, profit 350.
    // The dust claim is carried by its neighbour under a plain floor check, but it destroys 90 of profit.
    seed([discovered(0, 500n), discovered(1, 10n)]);

    await build().pollPortal(PORTAL_ID);

    expect(publish).toHaveBeenCalledTimes(1);
    const submitted = publish.mock.calls[0][1] as unknown[];
    expect(submitted).toHaveLength(1);
    // The dust claim stays backlogged for a cheaper block rather than riding along at a loss.
    expect(backlog.getPortalClaims(PORTAL_ID)).toHaveLength(1);
  });

  it('does not select a second batch while one is in flight', async () => {
    seed([discovered(0, 500n), discovered(1, 500n)]);
    let release!: () => void;
    publish.mockImplementation(() => Promise.resolve({ confirmed: new Promise<void>(resolve => (release = resolve)) }));
    const submitter = build();

    const first = submitter.pollPortal(PORTAL_ID);
    await new Promise(setImmediate);
    // A second batch could repeat a claim, and `claimProverTips` reverts the whole tx on a repeat.
    await submitter.pollPortal(PORTAL_ID);
    expect(publish).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('drops a claim already recorded on chain', async () => {
    const claim = discovered(0, 500n);
    seed([claim]);
    claimedLeaves.add(claim.leafId.toString());

    await build().pollPortal(PORTAL_ID);

    expect(publish).not.toHaveBeenCalled();
    expect(backlog.getPortalClaims(PORTAL_ID)).toHaveLength(0);
  });

  it('assembles once while re-pricing, then re-assembles the batch it is about to send', async () => {
    seed([discovered(0, 200n)]);
    const submitter = build();

    gasPriceWei = 2n;
    await submitter.pollPortal(PORTAL_ID);
    await submitter.pollPortal(PORTAL_ID);
    // Assembly signs with the TEE, so re-pricing must reuse the cached encoding.
    expect(buildProverClaimData).toHaveBeenCalledTimes(1);

    gasPriceWei = 1n;
    await submitter.pollPortal(PORTAL_ID);
    // Exactly one more: the freeze re-check that runs next to the send.
    expect(buildProverClaimData).toHaveBeenCalledTimes(2);
  });

  it('aborts the send when a selected claim stops being buildable', async () => {
    seed([discovered(0, 500n)]);
    // Succeeds while pricing, then a freeze lands and the re-check before the send refuses it.
    buildProverClaimData
      .mockResolvedValueOnce({ status: 'success', proverClaim: proverClaim() })
      .mockResolvedValueOnce({ status: 'error', reason: 'cut off by freeze' });

    await build().pollPortal(PORTAL_ID);

    expect(publish).not.toHaveBeenCalled();
    expect(backlog.getPortalClaims(PORTAL_ID)).toHaveLength(0);
  });

  it('returns a failed batch to the backlog instead of losing the tips', async () => {
    seed([discovered(0, 500n)]);
    publish.mockRejectedValue(new Error('reverted'));

    await build().pollPortal(PORTAL_ID);

    const backlogged = backlog.getPortalClaims(PORTAL_ID);
    expect(backlogged).toHaveLength(1);
    // Back to pending, so the next poll re-prices it rather than the tip being lost to a reverted tx.
    expect(backlogged[0].status).toBe('pending');
  });

  it('sends the batch with the fee values it was priced at', async () => {
    seed([discovered(0, 500n)]);

    await build().pollPortal(PORTAL_ID);

    // The tx must not carry a higher fee cap than the one the profit check charged.
    expect(publish.mock.calls[0][2]).toEqual({ maxFeePerGas: gasPriceWei, maxPriorityFeePerGas: 0n });
  });

  it('quotes as the prover, since claimProverTips credits msg.sender', async () => {
    seed([discovered(0, 500n)]);

    await build().pollPortal(PORTAL_ID);

    expect(estimateGas.mock.calls[0][1]).toEqual({ account: SENDER.toString() });
  });

  describe('with two portals', () => {
    /** A portal with its own claimed leaves and its own subsidy quote. */
    const makePortal = ({ claimed = new Set<string>(), subsidy = 0n } = {}) => {
      const l1Portal = EthAddress.random();
      const estimate = jest.fn((args: any, _opts: any) =>
        Promise.resolve(FIXED_GAS + PER_CLAIM_GAS * BigInt(args[1].length)),
      );
      const config = {
        context: { l1Portal, token: TOKEN, proverSubsidy: EthAddress.random() },
        adaptor: { buildProverClaimData: (...args: any[]) => buildProverClaimData(...args) },
        contract: {
          address: l1Portal,
          claimed: (_epoch: EpochNumber, leafId: bigint) => Promise.resolve(claimed.has(leafId.toString())),
          getContract: () => ({
            estimateGas: { claimProverTips: estimate },
            simulate: { claimProverTips: () => Promise.resolve({ result: subsidy }) },
          }),
        },
      } as any;
      return { id: portalId(l1Portal), config, estimate };
    };

    /** The same withdrawal leaf and tx on each portal, so only the portal tells the claims apart. */
    const sameClaimOn = (portals: { id: string }[], tip: bigint) => {
      const claim = discovered(0, tip);
      return portals.map(portal => ({ ...claim, portalId: portal.id }));
    };

    it('checks the claimed state on the portal that the claim belongs to', async () => {
      const claim = discovered(0, 500n);
      const a = makePortal({ claimed: new Set([claim.leafId.toString()]) });
      const b = makePortal();
      seed(sameClaimOn([a, b], 500n));
      const submitter = build({ portals: [a.config, b.config] });

      await submitter.pollPortal(a.id);
      await submitter.pollPortal(b.id);

      // Portal A already paid this leaf, so only portal B sends it, through its own contract.
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0][0]).toBe(b.config);
      expect(a.estimate).not.toHaveBeenCalled();
      expect(b.estimate).toHaveBeenCalled();
      expect(backlog.getPortalClaims(a.id)).toHaveLength(0);
    });

    it('prices each portal with the subsidy that its own contract quotes', async () => {
      // A tip of 100 against 150 gas at 1 wei loses 50. Portal B's subsidy of 100 makes it pay; portal A pays none.
      const a = makePortal({ subsidy: 0n });
      const b = makePortal({ subsidy: 100n });
      seed(sameClaimOn([a, b], 100n));
      const submitter = build({ portals: [a.config, b.config] });

      await submitter.pollPortal(a.id);
      await submitter.pollPortal(b.id);

      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0][0]).toBe(b.config);
      // Portal A's claim does not pay yet, so it stays backlogged.
      expect(backlog.getPortalClaims(a.id)).toHaveLength(1);
    });
  });
});
