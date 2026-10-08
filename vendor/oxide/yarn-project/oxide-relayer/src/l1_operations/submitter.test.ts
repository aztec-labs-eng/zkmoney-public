import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { TimeoutError } from '@aztec/foundation/error';
import { type DateProvider, TestDateProvider } from '@aztec/foundation/timer';

import { OperationExecutorAbi } from '@oxide/l1-contracts';
import { EXECUTOR_MIN_PAYOUT_CALLDATA_GAS } from '@oxide/oxide-client/l1_operation_quote.js';
import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type FeeValuesEIP1559,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type TransactionRequestEIP1559,
  decodeFunctionData,
  maxUint256,
  pad,
  toEventSelector,
} from 'viem';

import type { L1OperationsSubmissionConfig } from '../cli/config.js';
import type { SentL1Tx } from '../l1/l1_tx_queue.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';
import type { RelayerTelemetry } from '../relayer_telemetry.js';
import { openSqliteStateStore } from '../state/sqlite_store.js';
import { TEST_RELAYER_DEPLOYMENT } from '../state/test_fixtures.js';
import type { PendingL1Operation, StateStore } from '../state/types.js';
import { L1OperationScreener } from './l1_operation_screener.js';
import { L1OperationSubmitter, type L1OperationSubmitterDeps } from './submitter.js';
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
/** Gas a successful simulation uses unless the quote sets it; equal to the default gas estimate. */
const SIMULATED_GAS_USED = 100_000n;
const RECIPIENT = EthAddress.random();
const MAX_PENDING_AGE_MS = 48 * 60 * 60_000;
const REVERT = () => Promise.resolve({ status: 'failure' as const, error: new Error('execution reverted') });
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');

/** The log the payout token emits when the target pays `RECIPIENT`. */
const RECIPIENT_TRANSFER_LOG = {
  address: PAYOUT_TOKEN.toString() as Hex,
  topics: [TRANSFER, pad(TARGET.toString() as Hex, { size: 32 }), pad(RECIPIENT.toString() as Hex, { size: 32 })],
  data: '0x',
} as unknown as Log;

type SimulatedCall =
  | { status: 'success'; result: bigint; logs?: Log[]; gasUsed?: bigint }
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
  createdAt: new Date(),
};

interface FakeSenderOpts {
  /** The market fee values: the latest base fee plus the tip, and the tip. */
  feeValues?: FeeValuesEIP1559;
  maxFeePerGasCap?: bigint;
  /** Terminal outcome each send's `settled` monitor reports; a mined success when omitted. */
  outcome?: 'success' | 'reverted' | 'timeout';
}

function fakeSender(opts: FakeSenderOpts = {}) {
  let nextId = 0;
  const feeValues = opts.feeValues ?? { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };

  const sendTransaction = jest.fn((_request: TransactionRequestEIP1559): Promise<SentL1Tx> => {
    const id = nextId++;
    const txHash = `0x${(id + 1).toString(16).padStart(64, '0')}` as Hex;
    const outcome = opts.outcome ?? 'success';
    const settled =
      outcome === 'timeout'
        ? Promise.reject(new TimeoutError(`L1 transaction with nonce ${id} expired without a receipt`))
        : Promise.resolve({ status: outcome } as unknown as TransactionReceipt);
    // Pre-handled branch, like the real L1 tx queue provides.
    settled.catch(() => undefined);
    return Promise.resolve({ txHash, nonce: id, settled });
  });

  const client = {
    getBlock: jest.fn(() =>
      Promise.resolve({ number: 10n, baseFeePerGas: feeValues.maxFeePerGas - feeValues.maxPriorityFeePerGas }),
    ),
    estimateMaxPriorityFeePerGas: jest.fn(() => Promise.resolve(feeValues.maxPriorityFeePerGas)),
  } as unknown as PublicClient;
  const l1TxQueue: L1OperationSubmitterDeps['l1TxQueue'] = {
    address: SENDER.toString(),
    enqueue: submit => submit(sendTransaction),
    maxFeePerGasCap: opts.maxFeePerGasCap,
  };

  return { client, l1TxQueue, sendTransaction };
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
    feeValues?: FeeValuesEIP1559;
    maxFeePerGasCap?: bigint;
    outcome?: FakeSenderOpts['outcome'];
    allowUnprofitable?: boolean;
    dateProvider?: DateProvider;
    /** The `balanceOf` read of a `Balance` condition; a nonzero balance when omitted. */
    balance?: () => Promise<bigint>;
    telemetry?: RelayerTelemetry;
    withdrawalCompletion?: WithdrawalCompletion;
  } = {},
) {
  const l1 = fakeSender({
    feeValues: overrides.feeValues,
    maxFeePerGasCap: overrides.maxFeePerGasCap,
    outcome: overrides.outcome,
  });
  const quote = overrides.quote ?? (() => Promise.resolve({ status: 'success' as const, result: PAYOUT }));
  const simulateBlocks = jest.fn(async (args: unknown) => [
    { calls: [{ gasUsed: SIMULATED_GAS_USED, ...(await quote(args)) }] },
  ]);
  const estimateGas = jest.fn((_request: unknown) => Promise.resolve(100_000n));
  const readContract = jest.fn((_request: unknown) => (overrides.balance ?? (() => Promise.resolve(1n)))());
  Object.assign(l1.client, { simulateBlocks, estimateGas, readContract });
  const listed = overrides.listed ?? [];
  const screener = new L1OperationScreener(
    { isListed: address => listed.some(entry => entry.equals(address)) },
    overrides.predicate,
  );
  const submitter = new L1OperationSubmitter({
    executor: EXECUTOR,
    client: l1.client,
    l1TxQueue: l1.l1TxQueue,
    store,
    priceOracle: identityOracle,
    screener,
    config: {
      retryBackoffMs: 0,
      maxPendingAgeMs: MAX_PENDING_AGE_MS,
      ...overrides.config,
    },
    withdrawalCompletion: overrides.withdrawalCompletion ?? NO_WITHDRAWALS,
    allowUnprofitable: overrides.allowUnprofitable,
    dateProvider: overrides.dateProvider,
    telemetry: overrides.telemetry,
  });
  return { submitter, ...l1, simulateBlocks, estimateGas, readContract };
}

describe('L1OperationSubmitter', () => {
  it('defers when successful target execution costs more than its payout', async () => {
    await withStore(async store => {
      // A target can skip an inner call at low gas. Requiring payment forces the full execution path.
      const quote = jest.fn((request: unknown) => {
        const args = request as { blocks: Array<{ calls: Array<{ args: readonly unknown[] }> }> };
        const minPayout = args.blocks[0].calls[0].args[3];
        return Promise.resolve({
          status: 'success' as const,
          result: PAYOUT,
          gasUsed: minPayout === 0n ? 10_000n : 600_000n,
        });
      });
      const { submitter, estimateGas, sendTransaction } = buildSubmitter(store, { quote });
      estimateGas.mockImplementation(request => {
        const { args } = decodeFunctionData({ abi: OperationExecutorAbi, data: (request as { data: Hex }).data });
        return Promise.resolve(args[3] === 0n ? 10_000n : 600_000n);
      });

      const summary = await submitter.runOnce();

      expect(summary).toMatchObject({ submitted: 0, deferred: 1 });
      expect(sendTransaction).not.toHaveBeenCalled();
      expect((await store.getPendingL1Operation(OPERATION_ID))?.status).toBe('pending');
      // The gas simulation carries the quoted payout as its minimum payout.
      const gasSimulation = quote.mock.calls[1][0] as { blocks: Array<{ calls: Array<{ args: readonly unknown[] }> }> };
      expect(gasSimulation.blocks[0].calls[0].args[3]).toBe(PAYOUT);
    });
  });

  it('prices minPayout on the simulated gas used, not on the gas limit', async () => {
    await withStore(async store => {
      const feeValues = { maxFeePerGas: 4n, maxPriorityFeePerGas: 1n };
      // Break-even on the gas used after refunds, below the break-even on the 130k gas limit.
      const payout = (SIMULATED_GAS_USED + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS) * feeValues.maxFeePerGas;
      const { submitter, estimateGas, sendTransaction } = buildSubmitter(store, {
        feeValues,
        quote: () => Promise.resolve({ status: 'success' as const, result: payout }),
      });
      estimateGas.mockResolvedValue(130_000n);

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
      const [request] = sendTransaction.mock.calls[0];
      // The tx still carries the estimated gas limit.
      expect(request.gas).toBe(130_000n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS);
      expect(decodeFunctionData({ abi: OperationExecutorAbi, data: request.data as Hex }).args[3]).toBe(payout);
    });
  });

  it('defers when the gas simulation fails', async () => {
    await withStore(async store => {
      let calls = 0;
      const { submitter, sendTransaction } = buildSubmitter(store, {
        quote: () =>
          Promise.resolve(
            calls++ === 0
              ? { status: 'success' as const, result: PAYOUT }
              : { status: 'failure' as const, error: new Error('reverted') },
          ),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 0, deferred: 1 });
      expect(sendTransaction).not.toHaveBeenCalled();
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
      });
    });
  });

  it('prices a subsidy-only payout before using it as the estimation floor', async () => {
    await withStore(async store => {
      const feeValues = { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
      const quote = jest.fn((request: unknown) => {
        const args = request as { blocks: Array<{ calls: Array<FeeValuesEIP1559> }> };
        // A zero-tip refund earns only the gas-price-dependent withdrawal subsidy. An unpriced quote returns zero.
        const payout = args.blocks[0].calls[0].maxFeePerGas === feeValues.maxFeePerGas ? PAYOUT : 0n;
        return Promise.resolve({ status: 'success' as const, result: payout });
      });
      const { submitter, estimateGas, sendTransaction } = buildSubmitter(store, { feeValues, quote });
      estimateGas.mockImplementation(request => {
        const { args } = decodeFunctionData({ abi: OperationExecutorAbi, data: (request as { data: Hex }).data });
        // A zero floor permits the target to skip the inner call; the subsidy quote must make this floor nonzero.
        return Promise.resolve(args[3] === 0n ? 10_000n : 100_000n);
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, confirmed: 1, deferred: 0 });
      // The payout quote and the gas simulation.
      expect(quote).toHaveBeenCalledTimes(2);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      const estimateRequest = estimateGas.mock.calls[0][0] as { data: Hex };
      const estimated = decodeFunctionData({ abi: OperationExecutorAbi, data: estimateRequest.data as Hex });
      expect(estimated.args[3]).toBe(PAYOUT);
    });
  });

  it('does not inflate the estimation floor when the fee ceiling exceeds the effective price', async () => {
    await withStore(async store => {
      // The latest base fee is 3 and the tip is 1. A 100% headroom puts the ceiling at 3 x 2 + 1 = 7, above the
      // effective 4.
      const feeValues = { maxFeePerGas: 4n, maxPriorityFeePerGas: 1n };
      const tip = PAYOUT;
      const subsidyPerGasPrice = 100_000n;
      const effectivePrice = 4n;
      const payout = tip + subsidyPerGasPrice * effectivePrice;
      const quote = jest.fn((request: unknown) => {
        const args = request as {
          blocks: Array<{
            blockOverrides?: { baseFeePerGas: bigint };
            calls: Array<FeeValuesEIP1559 & { gasPrice?: bigint }>;
          }>;
        };
        const block = args.blocks[0];
        const call = block.calls[0];
        const baseFee = block.blockOverrides?.baseFeePerGas ?? 0n;
        const effective = baseFee + call.maxPriorityFeePerGas;
        const price = call.gasPrice ?? (call.maxFeePerGas < effective ? call.maxFeePerGas : effective);
        return Promise.resolve({ status: 'success' as const, result: tip + subsidyPerGasPrice * price });
      });
      const { submitter, estimateGas, sendTransaction } = buildSubmitter(store, {
        config: { maxFeeHeadroomPercent: 100 },
        feeValues,
        quote,
      });
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
      expect(sent[0]).toMatchObject({ maxFeePerGas: 7n, maxPriorityFeePerGas: 1n });
      const submitted = decodeFunctionData({ abi: OperationExecutorAbi, data: sent[0].data as Hex });
      expect(submitted.args[3]).toBe((100_000n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS) * 7n);
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
            blockOverrides: { baseFeePerGas: 0n },
            stateOverrides: [{ address: SENDER.toString(), balance: maxUint256 }],
            calls: [
              expect.objectContaining({ to: EXECUTOR.toString(), functionName: 'execute', from: SENDER.toString() }),
            ],
          },
        ],
        traceTransfers: true,
        validation: true,
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

  it('doubles the backoff on each reverting quote, up to 15 min, and keeps the operation pending', async () => {
    await withStore(async store => {
      const dateProvider = new TestDateProvider();
      const { submitter, sendTransaction } = buildSubmitter(store, {
        quote: REVERT,
        config: { retryBackoffMs: 30_000 },
        dateProvider,
      });

      const gaps: number[] = [];
      for (let poll = 0; poll < 9; poll++) {
        await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, dropped: 0 });
        const row = await store.getPendingL1Operation(OPERATION_ID);
        const gap = row!.nextCheckAt!.getTime() - row!.lastCheckedAt!.getTime();
        gaps.push(gap);
        dateProvider.advanceTime(gap / 1000);
      }

      expect(gaps.map(gap => gap / 1000)).toEqual([30, 60, 120, 240, 480, 900, 900, 900, 900]);
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 9,
        lastReason: 'simulation_reverted',
      });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe('operations of an older version', () => {
    it('continues the revert backoff from the attempts that an older relayer stored', async () => {
      await withStore(
        async store => {
          const { submitter } = buildSubmitter(store, { quote: REVERT, config: { retryBackoffMs: 30_000 } });

          await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, dropped: 0 });
          const row = await store.getPendingL1Operation(OPERATION_ID);
          expect(row).toMatchObject({ status: 'pending', attempts: 5 });
          // The fifth revert waits 30 s x 2^4.
          expect(row!.nextCheckAt!.getTime() - row!.lastCheckedAt!.getTime()).toBe(480_000);
        },
        { ...OPERATION, attempts: 4 },
      );
    });

    it('retries an Immediate sweep from an older resolver without a balance read', async () => {
      await withStore(async store => {
        const { submitter, readContract } = buildSubmitter(store, {
          quote: REVERT,
          balance: () => Promise.resolve(0n),
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, dropped: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'pending' });
        expect(readContract).not.toHaveBeenCalled();
      });
    });
  });

  describe('reverting Balance operation', () => {
    const BALANCE_TOKEN = EthAddress.random();
    const SIPA = EthAddress.random();
    const BALANCE_OPERATION: PendingL1Operation = {
      ...OPERATION,
      condition: L1OperationCondition.balance(BALANCE_TOKEN, SIPA),
    };

    it('drops the operation when the recipient no longer holds the token', async () => {
      await withStore(async store => {
        const { submitter, readContract } = buildSubmitter(store, {
          quote: REVERT,
          balance: () => Promise.resolve(0n),
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 1, deferred: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'dropped' });
        expect(readContract).toHaveBeenCalledWith(
          expect.objectContaining({
            address: BALANCE_TOKEN.toString(),
            functionName: 'balanceOf',
            args: [SIPA.toString()],
          }),
        );
      }, BALANCE_OPERATION);
    });

    it('keeps the revert backoff when the recipient still holds the token', async () => {
      await withStore(async store => {
        const { submitter } = buildSubmitter(store, { quote: REVERT, balance: () => Promise.resolve(1n) });

        await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 0, deferred: 1 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
          status: 'pending',
          attempts: 1,
          lastReason: 'simulation_reverted',
        });
      }, BALANCE_OPERATION);
    });

    it('keeps the revert backoff when the balance read fails', async () => {
      await withStore(async store => {
        const { submitter } = buildSubmitter(store, {
          quote: REVERT,
          balance: () => Promise.reject(new Error('rpc down')),
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 0, deferred: 1 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'pending' });
      }, BALANCE_OPERATION);
    });
  });

  describe('max pending age', () => {
    const STALE = { ...OPERATION, createdAt: new Date(Date.now() - MAX_PENDING_AGE_MS) };

    it('drops a reverting operation instead of deferring it', async () => {
      await withStore(async store => {
        const { submitter } = buildSubmitter(store, { quote: REVERT });

        await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 1, deferred: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'dropped' });
      }, STALE);
    });

    it('drops an unprofitable operation instead of deferring it', async () => {
      await withStore(async store => {
        // Break-even (100k gas x 10^13 wei) far exceeds the 500k-unit payout.
        const { submitter, sendTransaction } = buildSubmitter(store, {
          feeValues: { maxFeePerGas: 10n ** 13n, maxPriorityFeePerGas: 1n },
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 1, deferred: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'dropped' });
        expect(sendTransaction).not.toHaveBeenCalled();
      }, STALE);
    });

    it('still executes an old operation that succeeds', async () => {
      await withStore(async store => {
        const { submitter } = buildSubmitter(store);

        await expect(submitter.runOnce()).resolves.toMatchObject({ confirmed: 1, dropped: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'executed' });
      }, STALE);
    });

    it('keeps deferring an operation below the max age', async () => {
      await withStore(
        async store => {
          const { submitter } = buildSubmitter(store, { quote: REVERT });

          await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 0, deferred: 1 });
          await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'pending' });
        },
        { ...OPERATION, createdAt: new Date(Date.now() - MAX_PENDING_AGE_MS + 60_000) },
      );
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
        feeValues: { maxFeePerGas: 10n ** 13n, maxPriorityFeePerGas: 1n },
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
        feeValues: { maxFeePerGas: 10n ** 13n, maxPriorityFeePerGas: 1n },
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
        feeValues: { maxFeePerGas: 18n, maxPriorityFeePerGas: 2n },
        // Clears the break-even at the ceiling, which the default payout does not.
        quote: () => Promise.resolve({ status: 'success' as const, result: 2_000_000n }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1 });

      const [simulation] = simulateBlocks.mock.calls[0] as [
        { blocks: [{ calls: [FeeValuesEIP1559 & { gasPrice?: bigint }] }] },
      ];
      expect(simulation.blocks[0].calls[0]).toMatchObject({ maxFeePerGas: 19n, maxPriorityFeePerGas: 2n });
      expect(simulation.blocks[0].calls[0].gasPrice).toBeUndefined();
      expect(sendTransaction.mock.calls[0][0]).toMatchObject({ maxFeePerGas: 19n, maxPriorityFeePerGas: 2n });

      const [request] = estimateGas.mock.calls[0] as [
        {
          account: string;
          maxFeePerGas: bigint;
          maxPriorityFeePerGas: bigint;
          stateOverride: Array<{ address: string; balance: bigint }>;
        },
      ];
      // The ceiling the transaction carries is the base fee of 16 plus the default 6.25% headroom, plus the tip of 2;
      // `minPayout` follows it.
      expect(request).toMatchObject({ account: SENDER.toString(), maxFeePerGas: 19n, maxPriorityFeePerGas: 2n });
      // The balance override is what lets each priced call run without being capped by what the sender holds.
      expect(request.stateOverride).toEqual([{ address: SENDER.toString(), balance: maxUint256 }]);
    });
  });

  it('prices the fee ceiling and minPayout with the configured max fee headroom', async () => {
    await withStore(async store => {
      const gasLimit = 100_000n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS;
      // Break-even at the ceiling of 11: the base fee of 6 plus a 50% headroom, plus the tip of 2.
      const payout = gasLimit * 11n;
      const { submitter, sendTransaction } = buildSubmitter(store, {
        config: { maxFeeHeadroomPercent: 50 },
        feeValues: { maxFeePerGas: 8n, maxPriorityFeePerGas: 2n },
        quote: () => Promise.resolve({ status: 'success' as const, result: payout }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
      const [request] = sendTransaction.mock.calls[0];
      expect(request).toMatchObject({ maxFeePerGas: 11n, maxPriorityFeePerGas: 2n });
      expect(decodeFunctionData({ abi: OperationExecutorAbi, data: request.data as Hex }).args[3]).toBe(payout);
    });
  });

  it('defers a payout below the break-even at the configured fee ceiling', async () => {
    await withStore(async store => {
      const gasLimit = 100_000n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS;
      const { submitter, sendTransaction } = buildSubmitter(store, {
        config: { maxFeeHeadroomPercent: 50 },
        feeValues: { maxFeePerGas: 8n, maxPriorityFeePerGas: 2n },
        quote: () => Promise.resolve({ status: 'success' as const, result: gasLimit * 11n - 1n }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 0, deferred: 1 });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('defers without simulating when the fee ceiling after headroom is above the max fee per gas', async () => {
    await withStore(async store => {
      const l1OperationOutcome = jest.fn();
      // A 50% headroom on the base fee of 6, plus the tip of 2, puts the ceiling at 11; a cap of 10 is below it.
      const { submitter, sendTransaction, simulateBlocks } = buildSubmitter(store, {
        config: { maxFeeHeadroomPercent: 50 },
        feeValues: { maxFeePerGas: 8n, maxPriorityFeePerGas: 2n },
        maxFeePerGasCap: 10n,
        telemetry: { l1OperationOutcome } as unknown as RelayerTelemetry,
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 0, deferred: 1 });
      expect(simulateBlocks).not.toHaveBeenCalled();
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(l1OperationOutcome).toHaveBeenCalledWith('deferred', 'gas_price_above_max');
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
      });
    });
  });

  it('submits when the fee ceiling equals the max fee per gas', async () => {
    await withStore(async store => {
      const gasLimit = 100_000n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS;
      const { submitter, sendTransaction } = buildSubmitter(store, {
        config: { maxFeeHeadroomPercent: 50 },
        feeValues: { maxFeePerGas: 8n, maxPriorityFeePerGas: 2n },
        maxFeePerGasCap: 11n,
        quote: () => Promise.resolve({ status: 'success' as const, result: gasLimit * 11n }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
      expect(sendTransaction.mock.calls[0][0]).toMatchObject({ maxFeePerGas: 11n, maxPriorityFeePerGas: 2n });
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

  it('defers with completion_error when withdrawal calldata completion fails, without burning an attempt', async () => {
    await withStore(
      async store => {
        const { submitter, simulateBlocks, sendTransaction } = buildSubmitter(store, {
          withdrawalCompletion: {
            resolveCalldata: () => Promise.reject(new Error('aztec node down')),
          } as unknown as WithdrawalCompletion,
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, submitted: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
          status: 'pending',
          attempts: 0,
          lastReason: 'completion_error',
        });
        expect(simulateBlocks).not.toHaveBeenCalled();
        expect(sendTransaction).not.toHaveBeenCalled();
      },
      { ...OPERATION, condition: L1OperationCondition.messageInOutbox() },
    );
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
        feeValues: { maxFeePerGas: 10n ** 13n, maxPriorityFeePerGas: 1n },
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

async function withStore(
  fn: (store: StateStore) => Promise<void>,
  operation: PendingL1Operation = OPERATION,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oxide-relayer-l1-op-submit-'));
  const store = await openSqliteStateStore(path.join(dir, 'state.sqlite3'), TEST_RELAYER_DEPLOYMENT);
  try {
    await store.upsertPendingL1Operation(operation);
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
