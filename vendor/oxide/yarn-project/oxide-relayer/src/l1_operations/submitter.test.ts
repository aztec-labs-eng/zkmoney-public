import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { type L1TxRequest, type L1TxState, TxUtilsState } from '@aztec/ethereum/l1-tx-utils';
import { TimeoutError } from '@aztec/foundation/error';

import { OperationExecutorAbi } from '@oxide/l1-contracts';
import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type Hex,
  type Log,
  type TransactionReceipt,
  decodeFunctionData,
  maxUint256,
  pad,
  toEventSelector,
} from 'viem';

import type { L1OperationsSubmissionConfig } from '../cli/config.js';
import { EXECUTOR_MIN_PAYOUT_CALLDATA_GAS } from '../l1_utils.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';
import type { RelayerL1TxUtils } from '../relayer_l1_tx_utils.js';
import { openSqliteStateStore } from '../state/sqlite_store.js';
import { TEST_RELAYER_DEPLOYMENT } from '../state/test_fixtures.js';
import type { PendingL1Operation, StateStore } from '../state/types.js';
import { L1OperationScreener } from './l1_operation_screener.js';
import { L1OperationSubmitter } from './submitter.js';
import type { WithdrawalCompletion } from './withdrawal_completion.js';

/** Every operation here is conditioned on something other than the Outbox, so completion is never reached. */
const NO_WITHDRAWALS = {
  resolveCalldata: () => Promise.reject(new Error('unexpected withdrawal completion')),
} as unknown as WithdrawalCompletion;

const SENDER = EthAddress.random();
const EXECUTOR = EthAddress.random();
const TARGET = EthAddress.random();
const PAYOUT_TOKEN = EthAddress.random();
const CALLDATA = Buffer.from('deadbeef', 'hex');
const OPERATION_ID = `0x${'ab'.repeat(32)}` as Hex;
const PAYOUT = 500_000n;
const RECIPIENT = EthAddress.random();
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');

/** The log the payout token emits when the target pays `RECIPIENT`. */
const RECIPIENT_TRANSFER_LOG = {
  address: PAYOUT_TOKEN.toString() as Hex,
  topics: [TRANSFER, pad(TARGET.toString() as Hex, { size: 32 }), pad(RECIPIENT.toString() as Hex, { size: 32 })],
  data: '0x',
} as unknown as Log;

type SimulatedCall =
  | { status: 'success'; result: bigint; logs?: Log[] }
  | { status: 'failure'; error: Error; logs?: Log[] };

const OPERATION: PendingL1Operation = {
  operationId: OPERATION_ID,
  broadcaster: AztecAddress.fromBigIntUnsafe(7n),
  l2TxHash: '0xl2tx',
  l2BlockNumber: 5n,
  target: TARGET,
  payoutToken: PAYOUT_TOKEN,
  calldata: CALLDATA,
  condition: L1OperationCondition.immediate(),
  status: 'pending',
  attempts: 0,
};

interface GasPrice {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

interface FakeL1TxUtilsOpts {
  gasPrice?: GasPrice;
  /** Terminal outcome each send's `settled` monitor reports; a mined success when omitted. */
  outcome?: 'success' | 'reverted' | 'timeout';
}

function fakeL1TxUtils(opts: FakeL1TxUtilsOpts = {}) {
  let nextId = 0;
  const gasPrice = opts.gasPrice ?? { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };

  const sendTransactionWithGasPrice = jest.fn(
    (request: L1TxRequest, gasConfig?: { gasLimit?: bigint }, fee?: GasPrice) => {
      const id = nextId++;
      const txHash = `0x${(id + 1).toString(16).padStart(64, '0')}` as Hex;
      const state: L1TxState = {
        id,
        txHashes: [txHash],
        cancelTxHashes: [],
        gasLimit: gasConfig?.gasLimit ?? 100_000n,
        gasPrice: fee ?? gasPrice,
        txConfigOverrides: {},
        request: { to: request.to, data: request.data, value: request.value },
        status: TxUtilsState.SENT,
        nonce: id,
        sentAtL1Ts: new Date(),
        lastSentAtL1Ts: new Date(),
        blobInputs: undefined,
      };
      const outcome = opts.outcome ?? 'success';
      const settled =
        outcome === 'timeout'
          ? Promise.reject(new TimeoutError(`L1 transaction with nonce ${id} expired without a receipt`))
          : Promise.resolve({ status: outcome } as unknown as TransactionReceipt);
      // Pre-handled branch, like the real RelayerL1TxUtils provides.
      settled.catch(() => undefined);
      return Promise.resolve({ txHash, state, settled });
    },
  );

  const l1TxUtils = {
    sendTransactionWithGasPrice,
    getGasPrice: jest.fn(() => Promise.resolve(gasPrice)),
    getSenderAddress: () => SENDER,
  } as unknown as RelayerL1TxUtils;

  return { l1TxUtils, sendTransaction: sendTransactionWithGasPrice };
}

const identityOracle = {
  weiToUSD: (wei: bigint) => Promise.resolve(wei),
} as unknown as ChainlinkPriceOracle;

function buildSubmitter(
  store: StateStore,
  overrides: {
    /** The simulated call each quote resolves with; a successful `PAYOUT` quote when omitted. */
    quote?: (request: unknown) => Promise<SimulatedCall>;
    /** Addresses the fake SDN list holds. */
    listed?: EthAddress[];
    predicate?: { isCompliant: (address: EthAddress) => Promise<boolean> };
    config?: Partial<L1OperationsSubmissionConfig>;
    gasPrice?: GasPrice;
    outcome?: FakeL1TxUtilsOpts['outcome'];
    allowUnprofitable?: boolean;
  } = {},
) {
  const l1 = fakeL1TxUtils({ gasPrice: overrides.gasPrice, outcome: overrides.outcome });
  const quote = overrides.quote ?? (() => Promise.resolve({ status: 'success' as const, result: PAYOUT }));
  const simulateBlocks = jest.fn(async (args: unknown) => [{ calls: [await quote(args)] }]);
  const estimateGas = jest.fn((_request: unknown) => Promise.resolve(100_000n));
  (l1.l1TxUtils as unknown as { client: unknown }).client = {
    simulateBlocks,
    estimateGas,
    getBlock: jest.fn(() => Promise.resolve({ number: 10n, baseFeePerGas: 1n })),
  };
  const listed = overrides.listed ?? [];
  const screener = new L1OperationScreener(
    { isListed: address => listed.some(entry => entry.equals(address)) },
    overrides.predicate,
  );
  const submitter = new L1OperationSubmitter({
    executor: EXECUTOR,
    l1TxUtils: l1.l1TxUtils,
    store,
    priceOracle: identityOracle,
    screener,
    config: {
      retryBackoffMs: 0,
      maxRetries: 2,
      ...overrides.config,
    },
    withdrawalCompletion: NO_WITHDRAWALS,
    allowUnprofitable: overrides.allowUnprofitable,
  });
  return { submitter, ...l1, simulateBlocks, estimateGas };
}

describe('L1OperationSubmitter', () => {
  it('defers when successful target execution costs more than its payout', async () => {
    await withStore(async store => {
      const { submitter, estimateGas, sendTransaction } = buildSubmitter(store);
      estimateGas.mockImplementation(request => {
        const { args } = decodeFunctionData({ abi: OperationExecutorAbi, data: (request as { data: Hex }).data });
        // A target can skip an inner call at low gas. Requiring payment forces the full execution path.
        return Promise.resolve(args[3] === 0n ? 10_000n : 600_000n);
      });

      const summary = await submitter.runOnce();

      expect(summary).toMatchObject({ submitted: 0, deferred: 1 });
      expect(sendTransaction).not.toHaveBeenCalled();
      expect((await store.getPendingL1Operation(OPERATION_ID))?.status).toBe('pending');
    });
  });

  it('prices a subsidy-only payout before using it as the estimation floor', async () => {
    await withStore(async store => {
      const gasPrice = { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
      const quote = jest.fn((request: unknown) => {
        const args = request as { blocks: Array<{ calls: Array<GasPrice> }> };
        // A zero-tip refund earns only the gas-price-dependent withdrawal subsidy. An unpriced quote returns zero.
        const payout = args.blocks[0].calls[0].maxFeePerGas === gasPrice.maxFeePerGas ? PAYOUT : 0n;
        return Promise.resolve({ status: 'success' as const, result: payout });
      });
      const { submitter, estimateGas, sendTransaction } = buildSubmitter(store, { gasPrice, quote });
      estimateGas.mockImplementation(request => {
        const { args } = decodeFunctionData({ abi: OperationExecutorAbi, data: (request as { data: Hex }).data });
        // A zero floor permits the target to skip the inner call; the subsidy quote must make this floor nonzero.
        return Promise.resolve(args[3] === 0n ? 10_000n : 100_000n);
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, confirmed: 1, deferred: 0 });
      expect(quote).toHaveBeenCalledTimes(1);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      const estimateRequest = estimateGas.mock.calls[0][0] as { data: Hex };
      const estimated = decodeFunctionData({ abi: OperationExecutorAbi, data: estimateRequest.data as Hex });
      expect(estimated.args[3]).toBe(PAYOUT);
    });
  });

  it('does not inflate the estimation floor when the fee ceiling exceeds the effective price', async () => {
    await withStore(async store => {
      const gasPrice = { maxFeePerGas: 4n, maxPriorityFeePerGas: 1n };
      const tip = PAYOUT;
      const subsidyPerGasPrice = 100_000n;
      const effectivePrice = 2n;
      const payout = tip + subsidyPerGasPrice * effectivePrice;
      const quote = jest.fn((request: unknown) => {
        const args = request as {
          blocks: Array<{
            blockOverrides?: { baseFeePerGas: bigint };
            calls: Array<GasPrice & { gasPrice?: bigint }>;
          }>;
        };
        const block = args.blocks[0];
        const call = block.calls[0];
        const baseFee = block.blockOverrides?.baseFeePerGas ?? 0n;
        const effective = baseFee + call.maxPriorityFeePerGas;
        const price = call.gasPrice ?? (call.maxFeePerGas < effective ? call.maxFeePerGas : effective);
        return Promise.resolve({ status: 'success' as const, result: tip + subsidyPerGasPrice * price });
      });
      const { submitter, estimateGas, sendTransaction } = buildSubmitter(store, { gasPrice, quote });
      estimateGas.mockImplementation(request => {
        const { args } = decodeFunctionData({ abi: OperationExecutorAbi, data: (request as { data: Hex }).data });
        if (args[3] > payout) {
          return Promise.reject(new Error('quoted payout exceeds the effective-price payout'));
        }
        return Promise.resolve(args[3] === 0n ? 10_000n : 100_000n);
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, confirmed: 1, deferred: 0 });
      const estimateRequest = estimateGas.mock.calls[0][0] as { data: Hex };
      const estimated = decodeFunctionData({ abi: OperationExecutorAbi, data: estimateRequest.data as Hex });
      expect(estimated.args[3]).toBe(payout);
      const sent = sendTransaction.mock.calls[0];
      expect(sent[2]).toEqual(gasPrice);
      const submitted = decodeFunctionData({ abi: OperationExecutorAbi, data: sent[0].data as Hex });
      expect(submitted.args[3]).toBe((100_000n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS) * gasPrice.maxFeePerGas);
    });
  });

  it('submits with break-even pinned as minPayout', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction, simulateBlocks, estimateGas } = buildSubmitter(store);
      const summary = await submitter.runOnce();
      // The operation is submitted, awaited to a receipt, and confirmed within the same poll.
      expect(summary).toMatchObject({ submitted: 1, confirmed: 1, dropped: 0, blocked: 0 });

      // One block, one call, from the sender, with transfer tracing so ETH moves show up as logs.
      expect(simulateBlocks).toHaveBeenCalledWith({
        blockNumber: 10n,
        blocks: [
          {
            blockOverrides: { baseFeePerGas: 1n },
            stateOverrides: [{ address: SENDER.toString(), balance: maxUint256 }],
            calls: [
              expect.objectContaining({ to: EXECUTOR.toString(), functionName: 'execute', from: SENDER.toString() }),
            ],
          },
        ],
        traceTransfers: true,
      });
      const estimated = decodeFunctionData({
        abi: OperationExecutorAbi,
        data: (estimateGas.mock.calls[0][0] as { data: Hex }).data,
      });
      expect(estimated.args[3]).toBe(PAYOUT);
      const request = sendTransaction.mock.calls[0][0];
      expect(request.to).toBe(EXECUTOR.toString());
      const decoded = decodeFunctionData({ abi: OperationExecutorAbi, data: request.data as Hex });
      // Identity oracle: break-even = gasLimit (the 100k estimate plus the `minPayout` calldata gas) x
      // the fee ceiling (1), in token units.
      expect(decoded.args).toEqual([
        TARGET.toChecksumString(),
        `0x${CALLDATA.toString('hex')}`,
        PAYOUT_TOKEN.toChecksumString(),
        100_000n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS,
      ]);
    });
  });

  it('marks the operation executed once its tx mines successfully', async () => {
    await withStore(async store => {
      const { submitter } = buildSubmitter(store);

      const summary = await submitter.runOnce();

      expect(summary).toMatchObject({ submitted: 1, confirmed: 1 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'executed' });
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
    });
  });

  it('defers on a reverting quote and drops once the retry budget is spent', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction } = buildSubmitter(store, {
        quote: () => Promise.resolve({ status: 'failure', error: new Error('execution reverted') }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, dropped: 0 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 1,
        lastReason: 'simulation_reverted',
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 1 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'dropped' });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('defers an expired tx and re-sends it on the next poll', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction } = buildSubmitter(store, { outcome: 'timeout' });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, confirmed: 0, deferred: 1 });
      // The operation stays pending without burning an attempt; the zero backoff makes it due again.
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1 });
      expect(sendTransaction).toHaveBeenCalledTimes(2);
    });
  });

  it('defers an operation below the minimum payout without burning an attempt', async () => {
    await withStore(async store => {
      // Break-even (100k gas x 10^13 wei) far exceeds the 500k-unit payout.
      const { submitter, sendTransaction } = buildSubmitter(store, {
        gasPrice: { maxFeePerGas: 10n ** 13n, maxPriorityFeePerGas: 1n },
      });
      await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
        lastReason: 'unprofitable',
      });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('submits with a zero minPayout when allowUnprofitable drops the floor', async () => {
    await withStore(async store => {
      // The same break-even that defers the operation above, with the floor dropped.
      const { submitter, sendTransaction } = buildSubmitter(store, {
        gasPrice: { maxFeePerGas: 10n ** 13n, maxPriorityFeePerGas: 1n },
        allowUnprofitable: true,
      });
      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      // The sent transaction carries the same zero floor, so the executor cannot reject it on payout.
      const { data } = sendTransaction.mock.calls[0][0] as { data: Hex };
      expect(decodeFunctionData({ abi: OperationExecutorAbi, data }).args?.[3]).toBe(0n);
    });
  });

  it('simulates and estimates with the fee settings the transaction carries', async () => {
    await withStore(async store => {
      const { submitter, simulateBlocks, estimateGas, sendTransaction } = buildSubmitter(store, {
        gasPrice: { maxFeePerGas: 8n, maxPriorityFeePerGas: 2n },
        // Clears the break-even at the bumped ceiling, which the default payout does not.
        quote: () => Promise.resolve({ status: 'success' as const, result: 1_000_000n }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1 });

      const [simulation] = simulateBlocks.mock.calls[0] as [
        { blocks: [{ calls: [GasPrice & { gasPrice?: bigint }] }] },
      ];
      expect(simulation.blocks[0].calls[0]).toMatchObject({ maxFeePerGas: 9n, maxPriorityFeePerGas: 2n });
      expect(simulation.blocks[0].calls[0].gasPrice).toBeUndefined();
      expect(sendTransaction.mock.calls[0][2]).toEqual({ maxFeePerGas: 9n, maxPriorityFeePerGas: 2n });

      const [request] = estimateGas.mock.calls[0] as [
        {
          account: string;
          maxFeePerGas: bigint;
          maxPriorityFeePerGas: bigint;
          stateOverride: Array<{ address: string; balance: bigint }>;
        },
      ];
      // The ceiling the transaction carries is the market fee plus the 12.5% tick, and `minPayout` follows it.
      expect(request).toMatchObject({ account: SENDER.toString(), maxFeePerGas: 9n, maxPriorityFeePerGas: 2n });
      // The balance override is what lets each priced call run without being capped by what the sender holds.
      expect(request.stateOverride).toEqual([{ address: SENDER.toString(), balance: maxUint256 }]);
    });
  });

  it('defers a simulation transport error without burning an attempt', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction } = buildSubmitter(store, {
        quote: () => Promise.reject(new Error('HTTP request failed')),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, dropped: 0 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
        lastReason: undefined,
      });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('blocks an operation with a listed target before it is priced', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction, estimateGas } = buildSubmitter(store, { listed: [TARGET] });

      await expect(submitter.runOnce()).resolves.toMatchObject({ blocked: 1, deferred: 0, submitted: 0 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'blocked' });
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
      expect(estimateGas).not.toHaveBeenCalled();
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('blocks an operation whose simulation pays a listed recipient', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction, estimateGas } = buildSubmitter(store, {
        listed: [RECIPIENT],
        quote: () => Promise.resolve({ status: 'success', result: PAYOUT, logs: [RECIPIENT_TRANSFER_LOG] }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ blocked: 1, submitted: 0 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'blocked' });
      expect(estimateGas).not.toHaveBeenCalled();
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('defers with screening_error when Predicate fails, without burning an attempt', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction } = buildSubmitter(store, {
        predicate: { isCompliant: () => Promise.reject(new Error('predicate down')) },
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
        lastReason: 'screening_error',
      });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('re-screens a deferred operation and blocks it once the list gains its recipient', async () => {
    await withStore(async store => {
      const listed: EthAddress[] = [];
      const { submitter, sendTransaction } = buildSubmitter(store, {
        listed,
        // Break-even (100k gas x 10^13 wei) far exceeds the 500k-unit payout, so the first poll defers.
        gasPrice: { maxFeePerGas: 10n ** 13n, maxPriorityFeePerGas: 1n },
        quote: () => Promise.resolve({ status: 'success', result: PAYOUT, logs: [RECIPIENT_TRANSFER_LOG] }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        lastReason: 'unprofitable',
      });

      listed.push(RECIPIENT);
      await expect(submitter.runOnce()).resolves.toMatchObject({ blocked: 1 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'blocked' });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('defers a zero-payout quote even below the retry budget (OX-905: no zero-floor bypass)', async () => {
    await withStore(async store => {
      // A break-even floor above zero, from a nonzero gas price, always applies regardless of caller intent —
      // there is no config knob that pins `minPayout` to 0 for this unauthenticated broadcast channel.
      const { submitter, sendTransaction } = buildSubmitter(store, {
        quote: () => Promise.resolve({ status: 'success', result: 0n }),
      });
      await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        lastReason: 'unprofitable',
      });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });
});

async function withStore(fn: (store: StateStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oxide-relayer-l1-op-submit-'));
  const store = await openSqliteStateStore(path.join(dir, 'state.sqlite3'), TEST_RELAYER_DEPLOYMENT);
  try {
    await store.upsertPendingL1Operation(OPERATION);
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
