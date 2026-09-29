import { BlockNumber, CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';
import { TxHash } from '@aztec/stdlib/tx';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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

const L1_PORTAL = EthAddress.random();
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
        portalId: PORTAL_ID,
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
      context: { l1Portal: L1_PORTAL, proverSubsidy: EthAddress.random() },
      adaptor: { buildProverClaimData: (...args: any[]) => buildProverClaimData(...args) },
    } as any;
    return new ProfitableClaimBatchSubmitter({
      portal: portalContract,
      rollup: { getCheckpointNumber: () => Promise.resolve(CheckpointNumber(pendingCheckpoint)) } as any,
      portals: [portal],
      backlog,
      // Identity oracle, so profit reduces to tips minus gas cost.
      priceOracle: { weiToUSD: (wei: bigint) => Promise.resolve(wei) } as any,
      getEffectiveGasPriceWei: () => Promise.resolve(gasPriceWei),
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

  it('quotes as the prover, since claimProverTips credits msg.sender', async () => {
    seed([discovered(0, 500n)]);

    await build().pollPortal(PORTAL_ID);

    expect(estimateGas.mock.calls[0][1]).toEqual({ account: SENDER.toString() });
  });
});
