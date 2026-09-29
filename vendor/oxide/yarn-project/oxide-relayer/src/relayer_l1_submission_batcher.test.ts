import { type L1TxState, TxUtilsState } from '@aztec/ethereum/l1-tx-utils';
import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it, jest } from '@jest/globals';
import type { Hex, TransactionReceipt } from 'viem';

import { L1SubmissionType } from './l1_submission_batcher.js';
import { RelayerL1SubmissionBatcher } from './relayer_l1_submission_batcher.js';
import type { ProtectTxStatus, RelayerL1TxUtils, SentL1Tx } from './relayer_l1_tx_utils.js';

const REQUEST = { to: '0x0000000000000000000000000000000000000001' as Hex, data: '0x' as Hex };
const GAS_PRICE = { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };

function fakeL1TxUtils(hasProtectEndpoint = true) {
  let blockNumber = 100n;
  let latestNonce = 0;
  let nextNonce = 0;
  let nextId = 0;
  const statuses = new Map<Hex, ProtectTxStatus>();
  const labels = new Map<Hex, string>();
  const settlers = new Map<Hex, { mine(): void; expire(): void }>();
  const sends: Array<{ label: string; nonce: number; hash: Hex }> = [];
  const resetNonce = jest.fn(() => {
    nextNonce = 0;
  });

  const send = (request: { to: Hex }): Promise<SentL1Tx> => {
    const id = ++nextId;
    const nonce = nextNonce++;
    const txHash = `0x${id.toString(16).padStart(64, '0')}` as Hex;
    const state = {
      id,
      txHashes: [txHash],
      cancelTxHashes: [],
      gasLimit: 100_000n,
      gasPrice: GAS_PRICE,
      txConfigOverrides: {},
      request: REQUEST,
      status: TxUtilsState.SENT,
      nonce,
      sentAtL1Ts: new Date(),
      lastSentAtL1Ts: new Date(),
      blobInputs: undefined,
    } as L1TxState;
    sends.push({ label: labels.get(request.to) ?? request.to, nonce, hash: txHash });
    statuses.set(txHash, { status: 'PENDING' });
    const settled = new Promise<TransactionReceipt>((resolve, reject) =>
      settlers.set(txHash, {
        mine: () => resolve({} as TransactionReceipt),
        expire: () => reject(new Error('timed out')),
      }),
    );
    void settled.catch(() => {});
    return Promise.resolve({ txHash, state, settled });
  };

  const l1TxUtils = {
    client: {
      getBlockNumber: () => Promise.resolve(blockNumber),
      getTransactionCount: () => Promise.resolve(latestNonce),
    },
    getSenderAddress: () => EthAddress.random(),
    hasProtectTxStatusEndpoint: () => hasProtectEndpoint,
    getProtectTxStatus: (hash: Hex) => Promise.resolve(statuses.get(hash)),
    resetNonce,
    sendTransaction: (request: { to: Hex }) => send(request),
    sendTransactionWithGasPrice: (request: { to: Hex }) => send(request),
  } as unknown as RelayerL1TxUtils;

  return {
    l1TxUtils,
    sends,
    statuses,
    resetNonce,
    request(label: string) {
      const to = `0x${(labels.size + 1).toString(16).padStart(40, '0')}` as Hex;
      labels.set(to, label);
      return { ...REQUEST, to };
    },
    setBlockNumber(value: bigint) {
      blockNumber = value;
    },
    setLatestNonce(value: number) {
      latestNonce = value;
    },
    mine(hash: Hex) {
      settlers.get(hash)!.mine();
    },
    expire(hash: Hex) {
      settlers.get(hash)!.expire();
    },
  };
}

function enqueueSend(
  batcher: RelayerL1SubmissionBatcher,
  fake: ReturnType<typeof fakeL1TxUtils>,
  kind: L1SubmissionType,
  label: string,
  retry = false,
): Promise<SentL1Tx> {
  const request = fake.request(label);
  return batcher.enqueue({
    kind,
    retry,
    submit: sender => sender.sendTransactionWithGasPrice(request, { gasLimit: 100_000n }, GAS_PRICE),
  });
}

describe('RelayerL1SubmissionBatcher', () => {
  it('orders retries first and everything else by FIFO', async () => {
    const fake = fakeL1TxUtils();
    const batcher = new RelayerL1SubmissionBatcher({
      l1TxUtils: fake.l1TxUtils,
      blockWindow: 5,
      statusPollIntervalMs: 1,
    });

    const submissions = [
      enqueueSend(batcher, fake, L1SubmissionType.ProverClaim, 'prover claim'),
      enqueueSend(batcher, fake, L1SubmissionType.L1Operation, 'operation'),
      enqueueSend(batcher, fake, L1SubmissionType.FpcFunding, 'fpc'),
      enqueueSend(batcher, fake, L1SubmissionType.L1Operation, 'retry', true),
      enqueueSend(batcher, fake, L1SubmissionType.ProverClaim, 'prover'),
    ];
    await Promise.all(submissions);
    for (const { hash } of fake.sends) {
      fake.statuses.set(hash, { status: 'INCLUDED' });
    }

    expect(fake.sends.map(send => send.label)).toEqual(['retry', 'prover claim', 'operation', 'fpc', 'prover']);
    await batcher.stop();
  });

  it('holds a new snapshot through NonceTooHigh and resets the nonce after block expiry', async () => {
    const fake = fakeL1TxUtils();
    const batcher = new RelayerL1SubmissionBatcher({
      l1TxUtils: fake.l1TxUtils,
      blockWindow: 5,
      statusPollIntervalMs: 1,
    });

    const first = await enqueueSend(batcher, fake, L1SubmissionType.L1Operation, 'first');
    fake.statuses.set(first.txHash, { status: 'PENDING', simError: 'NonceTooHigh' });
    const secondPromise = enqueueSend(batcher, fake, L1SubmissionType.ProverClaim, 'second');
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    expect(fake.sends.map(send => send.label)).toEqual(['first']);

    fake.setBlockNumber(107n);
    await expect(secondPromise).resolves.toMatchObject({ state: { nonce: 0 } });
    expect(fake.resetNonce).toHaveBeenCalledTimes(1);
    expect(fake.sends.map(send => send.nonce)).toEqual([0, 0]);
    await batcher.stop();
  });

  it('opens the next snapshot early when every Protect transaction is terminal', async () => {
    const fake = fakeL1TxUtils();
    const batcher = new RelayerL1SubmissionBatcher({
      l1TxUtils: fake.l1TxUtils,
      blockWindow: 5,
      statusPollIntervalMs: 1,
    });

    const first = await enqueueSend(batcher, fake, L1SubmissionType.L1Operation, 'first');
    fake.statuses.set(first.txHash, { status: 'FAILED', simError: 'ExecutionReverted' });
    await expect(enqueueSend(batcher, fake, L1SubmissionType.ProverClaim, 'second')).resolves.toMatchObject({
      state: { nonce: 0 },
    });

    expect(fake.resetNonce).toHaveBeenCalledTimes(1);
    await batcher.stop();
  });

  it('does not promote a later submission from a failed type', async () => {
    const fake = fakeL1TxUtils();
    const batcher = new RelayerL1SubmissionBatcher({
      l1TxUtils: fake.l1TxUtils,
      blockWindow: 5,
      statusPollIntervalMs: 1,
    });

    const first = await enqueueSend(batcher, fake, L1SubmissionType.ProverClaim, 'failed prover claim');
    fake.statuses.set(first.txHash, { status: 'FAILED', simError: 'ExecutionReverted' });
    const operation = enqueueSend(batcher, fake, L1SubmissionType.L1Operation, 'operation');
    const claimRetry = enqueueSend(batcher, fake, L1SubmissionType.ProverClaim, 'claim retry');
    await Promise.all([operation, claimRetry]);

    expect(fake.sends.map(send => send.label)).toEqual(['failed prover claim', 'operation', 'claim retry']);
    await batcher.stop();
  });

  it('holds a new snapshot past the block window and the local expiry until the chain consumes every nonce without a Protect endpoint', async () => {
    const fake = fakeL1TxUtils(false);
    const batcher = new RelayerL1SubmissionBatcher({
      l1TxUtils: fake.l1TxUtils,
      blockWindow: 5,
      statusPollIntervalMs: 1,
    });
    const [first, second] = await Promise.all([
      enqueueSend(batcher, fake, L1SubmissionType.L1Operation, 'first'),
      enqueueSend(batcher, fake, L1SubmissionType.L1Operation, 'second'),
    ]);
    const thirdPromise = enqueueSend(batcher, fake, L1SubmissionType.ProverClaim, 'third');
    fake.setBlockNumber(200n);
    fake.expire(first.txHash);
    fake.expire(second.txHash);
    fake.setLatestNonce(first.state.nonce + 1);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    expect(fake.sends.map(send => send.label)).toEqual(['first', 'second']);
    fake.setLatestNonce(second.state.nonce + 1);
    await expect(thirdPromise).resolves.toBeDefined();
    expect(fake.resetNonce).not.toHaveBeenCalled();
    await batcher.stop();
  });

  it('opens the next snapshot as soon as the chain consumes the nonces without a Protect endpoint', async () => {
    const fake = fakeL1TxUtils(false);
    const batcher = new RelayerL1SubmissionBatcher({
      l1TxUtils: fake.l1TxUtils,
      blockWindow: 5,
      statusPollIntervalMs: 1,
    });
    const first = await enqueueSend(batcher, fake, L1SubmissionType.L1Operation, 'first');
    const secondPromise = enqueueSend(batcher, fake, L1SubmissionType.ProverClaim, 'second');
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    expect(fake.sends.map(send => send.label)).toEqual(['first']);
    fake.mine(first.txHash);
    fake.setLatestNonce(first.state.nonce + 1);
    await expect(secondPromise).resolves.toBeDefined();
    expect(fake.resetNonce).not.toHaveBeenCalled();
    await batcher.stop();
  });

  it('continues a snapshot after a callback fails', async () => {
    const fake = fakeL1TxUtils(false);
    const batcher = new RelayerL1SubmissionBatcher({
      l1TxUtils: fake.l1TxUtils,
      blockWindow: 5,
      statusPollIntervalMs: 1,
    });
    const failed = batcher.enqueue({
      kind: L1SubmissionType.L1Operation,
      submit: () => Promise.reject(new Error('prepare failed')),
    });
    const succeeded = enqueueSend(batcher, fake, L1SubmissionType.ProverClaim, 'prover claim');

    await expect(failed).rejects.toThrow('prepare failed');
    await expect(succeeded).resolves.toBeDefined();
    expect(fake.sends.map(send => send.label)).toEqual(['prover claim']);
    await batcher.stop();
  });
});
