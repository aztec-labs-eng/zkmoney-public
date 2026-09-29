/**
 * The queue's drop-and-reuse behaviour against a real chain. Mainnet submission goes through a revert-protecting
 * relay that can silently drop a tx inside its window (see the relayer's `l1_submission_rpc`), and the relayer
 * answers the local expiry by re-submitting the operation at the freed nonce. The rest of the suite stubs the
 * base class, so nothing there covers the part that has to hold on-chain: that the nonce is really free.
 *
 * Anvil reproduces both halves deterministically. `anvil_dropTransaction` is the relay dropping a tx, and mined
 * empty blocks are the clock the expiry reads — `L1TxUtils.isTxTimedOut` compares block timestamps, not wall
 * clock, so a test that only sleeps never expires anything and a node with mining off never expires anything
 * either.
 */
import type { GasPrice } from '@aztec/ethereum/l1-tx-utils';
import { startAnvil } from '@aztec/ethereum/test';
import { TimeoutError } from '@aztec/foundation/error';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  type Hex,
  type PublicClient,
  type TestClient,
  createTestClient,
  createWalletClient,
  http,
  publicActions,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { type RelayerL1TxUtils, type SentL1Tx, createRelayerL1TxUtils } from './relayer_l1_tx_utils.js';

/** Anvil's first dev account, funded at genesis. */
const ACCOUNT = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
/** Expiry in L1 seconds, not wall clock: the test mines the blocks that cross it. */
const TX_TIMEOUT_MS = 24_000;
/** A plain transfer to a second dev account: it always succeeds, so two sends differ only in nonce. */
const REQUEST = { to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Hex, data: '0x' as Hex };

describe('RelayerL1TxUtils against anvil', () => {
  let stopAnvil: () => Promise<void>;
  let url: string;
  let publicClient: PublicClient;
  let testClient: TestClient;
  let utils: RelayerL1TxUtils;
  /** Every send of the current test, so teardown can wait out the monitor loops still polling. */
  let sent: SentL1Tx[];

  beforeAll(async () => {
    ({ rpcUrl: url, stop: stopAnvil } = await startAnvil({ port: 0 }));
    publicClient = createTestClient({ chain: foundry, mode: 'anvil', transport: http(url) }).extend(
      publicActions,
    ) as unknown as PublicClient;
    testClient = createTestClient({ chain: foundry, mode: 'anvil', transport: http(url) });
    // Mining off: blocks are produced only by the test, which is what makes the expiry clock deterministic.
    await testClient.setAutomine(false);
  }, 30_000);

  afterAll(async () => {
    await stopAnvil?.();
  });

  // The loser of a nonce race is still being monitored when its test ends. Interrupting is not enough on its own:
  // the loop settles one poll later, and jest reports the timer it sleeps on as a leak if we do not wait for it.
  afterEach(async () => {
    utils?.interrupt();
    await Promise.allSettled(sent.map(tx => tx.settled));
  });

  beforeEach(() => {
    sent = [];
    const wallet = createWalletClient({ account: ACCOUNT, chain: foundry, transport: http(url) }).extend(publicActions);
    utils = createRelayerL1TxUtils(wallet as any, {
      txTimeoutMs: TX_TIMEOUT_MS,
      stallTimeMs: TX_TIMEOUT_MS,
      checkIntervalMs: 50,
      maxSpeedUpAttempts: 0,
      gasLimitBufferPercentage: 0,
      priorityFeeRetryBumpPercentage: 0,
    });
  });

  /** Mines one block far enough ahead that the monitor loop sees the expiry cross. */
  async function expire(): Promise<void> {
    const { timestamp } = await publicClient.getBlock({ blockTag: 'latest' });
    await testClient.setNextBlockTimestamp({ timestamp: timestamp + BigInt(TX_TIMEOUT_MS / 1000 + 1) });
    await testClient.mine({ blocks: 1 });
  }

  /** The relay accepted the tx and then dropped it inside its window: it never reaches a block. */
  async function dropAndExpire(tx: SentL1Tx): Promise<void> {
    await testClient.dropTransaction({ hash: tx.txHash });
    await expire();
    await expect(tx.settled).rejects.toThrow(TimeoutError);
  }

  function senderNonce(): Promise<number> {
    return publicClient.getTransactionCount({ address: ACCOUNT.address, blockTag: 'latest' });
  }

  /** Sends through the queue and registers the result, so teardown can wait for its monitor loop. */
  async function send(): Promise<SentL1Tx> {
    const tx = await utils.sendTransaction(REQUEST);
    sent.push(tx);
    return tx;
  }

  async function sendWithGasPrice(gasPrice: GasPrice): Promise<SentL1Tx> {
    const tx = await utils.sendTransactionWithGasPrice(REQUEST, { gasLimit: 21_000n }, gasPrice);
    sent.push(tx);
    return tx;
  }

  it('reuses the nonce of a dropped tx, so a drop costs a re-submission and not a stranded gap', async () => {
    const before = await senderNonce();
    const dropped = await send();
    expect(dropped.state.nonce).toBe(before);
    await dropAndExpire(dropped);

    const resubmitted = await send();
    // The freed nonce, not `before + 1`: `lastSentNonce` is cleared on the NOT_MINED transition, so the send
    // takes the chain's count instead of its own lower bound.
    expect(resubmitted.state.nonce).toBe(before);

    await testClient.mine({ blocks: 1 });
    expect((await resubmitted.settled).status).toBe('success');
    expect(await senderNonce()).toBe(before + 1);
  }, 30_000);

  it('broadcasts a sequential nonce batch before any transaction is mined', async () => {
    const before = await senderNonce();
    const gasPrices: GasPrice[] = [
      { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 100_000_000n },
      { maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 200_000_000n },
      { maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 300_000_000n },
    ];

    const batch = await Promise.all(gasPrices.map(gasPrice => sendWithGasPrice(gasPrice)));

    expect(batch.map(tx => tx.state.nonce)).toEqual([before, before + 1, before + 2]);
    await expect(publicClient.getTransactionCount({ address: ACCOUNT.address, blockTag: 'pending' })).resolves.toBe(
      before + 3,
    );
    const pending = await Promise.all(batch.map(tx => publicClient.getTransaction({ hash: tx.txHash })));
    expect(
      pending.map(tx => ({
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      })),
    ).toEqual(gasPrices);

    await testClient.mine({ blocks: 1 });
    await expect(Promise.all(batch.map(tx => tx.settled))).resolves.toEqual([
      expect.objectContaining({ status: 'success' }),
      expect.objectContaining({ status: 'success' }),
      expect.objectContaining({ status: 'success' }),
    ]);
    expect(await senderNonce()).toBe(before + 3);
  }, 30_000);
});
