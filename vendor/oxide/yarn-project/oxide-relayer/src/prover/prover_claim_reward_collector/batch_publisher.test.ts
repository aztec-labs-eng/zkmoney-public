import { CheckpointNumber } from '@aztec/foundation/branded-types';
import { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';
import { sleep } from '@aztec/foundation/sleep';

import { ProverClaim } from '@oxide/l1-contracts/oxide_portal.js';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ProverPortalConfig } from '../prover_claim_lib/index.js';
import { BatchPublisher, BatchPublisherOptions } from './batch_publisher.js';

const POLL_MS = 5;

const claim: ProverClaim = {
  claimArgs: {
    content: { executor: EthAddress.random(), userPayloadHash: Fr.random(), amount: 1n, proverTip: 1n, randomness: 0n },
    checkpointNumber: CheckpointNumber(1),
    withdrawalId: '0x'.padEnd(66, '0') as any,
    teeSignature: '0x' as any,
  },
  epochNumber: 1n as any,
  messageLeafIndex: 0n,
  path: [],
  proofLength: 1n,
  checkpointNumber: CheckpointNumber(1),
};

const portal = {
  context: { l1Portal: EthAddress.random(), proverSubsidy: EthAddress.random() },
} as ProverPortalConfig;

type MinedReceipt = { blockNumber: bigint; transactionHash: `0x${string}`; status: 'success' | 'reverted' };

describe('BatchPublisher', () => {
  let head: bigint;
  let getBlockNumber: jest.Mock<() => Promise<bigint>>;
  let getTransactionReceipt: jest.Mock<(arg: { hash: `0x${string}` }) => Promise<MinedReceipt>>;
  let sendTransaction: jest.Mock<() => Promise<{ txHash: `0x${string}`; settled: Promise<MinedReceipt> }>>;

  const minedReceipt: MinedReceipt = { blockNumber: 100n, transactionHash: '0xabc', status: 'success' };

  const build = (overrides: Partial<BatchPublisherOptions> = {}) => {
    const portal = {
      address: EthAddress.random(),
      getContract: () => ({ simulate: { claimProverTips: () => Promise.resolve() } }),
    } as any;
    const l1TxUtils = {
      getSenderAddress: () => EthAddress.random(),
      // The queued utils monitor their own sends, so `settled` is the mined receipt.
      sendTransaction: (...a: any[]) => (sendTransaction as any)(...a),
      client: {
        getBlockNumber: () => getBlockNumber(),
        getTransactionReceipt: (arg: any) => getTransactionReceipt(arg),
      },
    } as any;
    const publisher = new BatchPublisher({
      portal,
      l1TxUtils,
      confirmations: 3n,
      confirmationPollIntervalMs: POLL_MS,
      ...overrides,
    });
    publisher.start();
    return publisher;
  };

  // Resolves to 'resolved'/'rejected' once settled, or 'pending' if still unsettled after a short grace period.
  const settle = async (p: Promise<void>): Promise<'resolved' | 'rejected' | 'pending'> => {
    let state: 'resolved' | 'rejected' | 'pending' = 'pending';
    p.then(
      () => (state = 'resolved'),
      () => (state = 'rejected'),
    );
    await sleep(POLL_MS * 6);
    return state;
  };

  beforeEach(() => {
    head = 100n;
    getBlockNumber = jest.fn(() => Promise.resolve(head));
    getTransactionReceipt = jest.fn(() => Promise.resolve(minedReceipt));
    sendTransaction = jest.fn(() =>
      Promise.resolve({ txHash: '0xabc' as const, settled: Promise.resolve(minedReceipt) }),
    );
  });

  it('publish resolves at mined; confirmed resolves only once the tx is confirmations blocks deep', async () => {
    const publisher = build();
    const { confirmed } = await publisher.publish(portal, [claim]); // resolves at mined

    expect(await settle(confirmed)).toBe('pending'); // head 100, mined at 100 => 1 block deep < 3

    head = 102n; // 100..102 => 3 blocks deep
    await expect(confirmed).resolves.toBeUndefined();
    expect(getTransactionReceipt).toHaveBeenCalled();
  });

  it('confirmed rejects when the tx was reorged out (receipt missing at depth)', async () => {
    getTransactionReceipt.mockRejectedValue(new Error('not found'));
    const publisher = build();
    head = 102n;

    const { confirmed } = await publisher.publish(portal, [claim]);
    await expect(confirmed).rejects.toThrow(/reorged out or reverted/);
  });

  it('confirmed rejects when the re-checked receipt is reverted', async () => {
    getTransactionReceipt.mockResolvedValue({ ...minedReceipt, status: 'reverted' });
    const publisher = build();
    head = 102n;

    const { confirmed } = await publisher.publish(portal, [claim]);
    await expect(confirmed).rejects.toThrow(/reorged out or reverted/);
  });

  it('confirmed keeps waiting when re-mined into a deeper block and resolves at the new depth', async () => {
    getTransactionReceipt.mockResolvedValue({ ...minedReceipt, blockNumber: 105n });
    const publisher = build();
    head = 102n; // first depth check passes (100..102) but fresh receipt is at 105
    const { confirmed } = await publisher.publish(portal, [claim]);

    expect(await settle(confirmed)).toBe('pending'); // now measuring from 105; head 102 < 105

    head = 107n; // 105..107 => 3 blocks deep
    await expect(confirmed).resolves.toBeUndefined();
  });

  it('confirmed resolves immediately at the mined receipt when confirmations is 0n', async () => {
    const publisher = build({ confirmations: 0n });

    const { confirmed } = await publisher.publish(portal, [claim]);
    await expect(confirmed).resolves.toBeUndefined();
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("keeps a later publish's confirmed independent of an earlier tx that fails to confirm", async () => {
    const publisher = build();
    head = 102n;

    // The first tx is reorged out; the second confirms normally.
    getTransactionReceipt.mockRejectedValueOnce(new Error('not found'));
    const first = await publisher.publish(portal, [claim]);
    await expect(first.confirmed).rejects.toThrow(/reorged out or reverted/);

    const second = await publisher.publish(portal, [claim]);
    // Confirmations are not chained: the collector retries the first batch, so a later batch must still settle.
    await expect(second.confirmed).resolves.toBeUndefined();
  });
});
