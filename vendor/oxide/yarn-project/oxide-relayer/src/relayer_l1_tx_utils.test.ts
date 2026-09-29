import { type GasPrice, type L1TxRequest, type L1TxState, L1TxUtils, TxUtilsState } from '@aztec/ethereum/l1-tx-utils';
import { TimeoutError } from '@aztec/foundation/error';
import { EthAddress } from '@aztec/foundation/eth-address';
import { sleep } from '@aztec/foundation/sleep';

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Hex, TransactionReceipt } from 'viem';

import { RelayerL1TxUtils } from './relayer_l1_tx_utils.js';

describe('RelayerL1TxUtils sendInOrder', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const receipt = { status: 'success' } as unknown as TransactionReceipt;

  function makeWrapper(protectTxStatusUrl?: string): RelayerL1TxUtils {
    const signer = jest.fn(() => Promise.resolve({ r: '0x0' as Hex, s: '0x0' as Hex, v: 27n })) as any;
    return new RelayerL1TxUtils({
      client: {} as any,
      address: EthAddress.random(),
      signer,
      config: {},
      protectTxStatusUrl,
    });
  }

  /** sendInOrder starts a monitor after each broadcast, so send stubs need a monitor stub as well. */
  function stubBaseMonitorTransaction() {
    return jest.spyOn(L1TxUtils.prototype, 'monitorTransaction' as any).mockResolvedValue(receipt as never);
  }

  function stubBaseSendTransaction(): { calls: number[]; inFlight: () => number; maxInFlight: () => number } {
    const nonces: number[] = [];
    let chainNonce = 0;
    let inFlight = 0;
    let maxInFlight = 0;

    jest.spyOn(L1TxUtils.prototype, 'sendTransaction').mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const nonce = chainNonce;
      // Without a pause here, the test passes even if sendInOrder is removed.
      await sleep(0);
      chainNonce = nonce + 1;
      nonces.push(nonce);
      inFlight--;
      return {
        txHash: `0x${nonce.toString(16).padStart(64, '0')}` as Hex,
        state: { nonce, status: TxUtilsState.SENT } as L1TxState,
      };
    });

    return { calls: nonces, inFlight: () => inFlight, maxInFlight: () => maxInFlight };
  }

  const request: L1TxRequest = { to: '0x0000000000000000000000000000000000000001' as Hex, data: '0x' as Hex };
  const gasPrice: GasPrice = { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };

  it('serializes concurrent sendTransaction calls so nonces do not collide', async () => {
    const stub = stubBaseSendTransaction();
    stubBaseMonitorTransaction();
    const wrapper = makeWrapper();

    const results = await Promise.all([
      wrapper.sendTransaction(request),
      wrapper.sendTransaction(request),
      wrapper.sendTransaction(request),
    ]);

    expect(stub.maxInFlight()).toBe(1);
    expect(results.map(r => r.state.nonce)).toEqual([0, 1, 2]);
    expect(stub.calls).toEqual([0, 1, 2]);
  });

  it('serializes a plain sendTransaction against a concurrent sendTransactionWithGasPrice', async () => {
    // Callers sharing one signer (e.g. deposit sweeps and withdrawal batches) must flow through the same queue.
    const stub = stubBaseSendTransaction();
    stubBaseMonitorTransaction();
    const wrapper = makeWrapper();

    const results = await Promise.all([
      wrapper.sendTransaction(request),
      wrapper.sendTransactionWithGasPrice(request, undefined, gasPrice),
      wrapper.sendTransaction(request),
      wrapper.sendTransactionWithGasPrice(request, undefined, gasPrice),
    ]);

    expect(stub.maxInFlight()).toBe(1);
    expect(results.map(r => r.state.nonce)).toEqual([0, 1, 2, 3]);
  });

  it('broadcasts the next transaction without waiting for the previous monitor', async () => {
    let releaseMonitor: (r: TransactionReceipt) => void;
    const monitorGate = new Promise<TransactionReceipt>(resolve => (releaseMonitor = resolve));
    const sendSpy = jest
      .spyOn(L1TxUtils.prototype, 'sendTransaction')
      .mockResolvedValueOnce({ txHash: '0x1' as Hex, state: { nonce: 0, status: TxUtilsState.SENT } as L1TxState })
      .mockResolvedValueOnce({ txHash: '0x2' as Hex, state: { nonce: 1, status: TxUtilsState.SENT } as L1TxState });
    jest
      .spyOn(L1TxUtils.prototype, 'monitorTransaction' as any)
      .mockReturnValueOnce(monitorGate as never)
      .mockResolvedValueOnce(receipt as never);
    const wrapper = makeWrapper();

    const first = await wrapper.sendTransaction(request);
    const second = wrapper.sendTransaction(request);
    try {
      await sleep(0);
      expect(sendSpy).toHaveBeenCalledTimes(2);
      await expect(second).resolves.toMatchObject({ state: { nonce: 1 } });
    } finally {
      releaseMonitor!(receipt);
      await first.settled;
    }
  });

  it('reports monitor expiry without blocking a later broadcast', async () => {
    let rejectMonitor: (err: Error) => void;
    const monitorGate = new Promise<TransactionReceipt>((_, reject) => (rejectMonitor = reject));
    const sendSpy = jest.spyOn(L1TxUtils.prototype, 'sendTransaction').mockImplementation(() =>
      Promise.resolve({
        txHash: '0x1' as Hex,
        state: { nonce: 0, status: TxUtilsState.SENT } as L1TxState,
      }),
    );
    jest
      .spyOn(L1TxUtils.prototype, 'monitorTransaction' as any)
      .mockReturnValueOnce(monitorGate as never)
      .mockResolvedValue(receipt as never);
    const wrapper = makeWrapper();

    const first = await wrapper.sendTransaction(request);
    const second = wrapper.sendTransaction(request);
    await sleep(0);
    expect(sendSpy).toHaveBeenCalledTimes(2);

    rejectMonitor!(new TimeoutError('expired'));
    await expect(first.settled).rejects.toThrow(TimeoutError);
    await expect(second).resolves.toBeDefined();
  });

  it('starts exactly one monitor loop per send, shared with settled', async () => {
    let releaseMonitor: (r: TransactionReceipt) => void;
    const monitorGate = new Promise<TransactionReceipt>(resolve => (releaseMonitor = resolve));
    jest.spyOn(L1TxUtils.prototype, 'sendTransaction').mockImplementation(() =>
      Promise.resolve({
        txHash: '0x1' as Hex,
        state: { nonce: 0, status: TxUtilsState.SENT } as L1TxState,
      }),
    );
    const monitorSpy = jest
      .spyOn(L1TxUtils.prototype, 'monitorTransaction' as any)
      .mockReturnValue(monitorGate as never);
    const wrapper = makeWrapper();

    const { settled } = await wrapper.sendTransaction(request);
    // One base loop total: internal observation and the caller's `settled` share it.
    expect(monitorSpy).toHaveBeenCalledTimes(1);

    releaseMonitor!(receipt);
    await expect(settled).resolves.toBe(receipt);
  });

  it('reads transaction status from the configured Protect endpoint', async () => {
    expect(makeWrapper().hasProtectTxStatusEndpoint()).toBe(false);
    const wrapper = makeWrapper('https://protect.flashbots.net/tx/');
    expect(wrapper.hasProtectTxStatusEndpoint()).toBe(true);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'FAILED', simError: 'ExecutionReverted' }),
    } as Response);

    await expect(wrapper.getProtectTxStatus('0xabc')).resolves.toEqual({
      status: 'FAILED',
      simError: 'ExecutionReverted',
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://protect.flashbots.net/tx/0xabc');
  });

  it('bounds a Protect status request with an abort signal', async () => {
    const wrapper = makeWrapper('https://protect.flashbots.net/tx/');
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'PENDING' }),
    } as Response);

    await wrapper.getProtectTxStatus('0xabc');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://protect.flashbots.net/tx/0xabc',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('scopes the gas-price override to a single sendTransactionWithGasPrice call', async () => {
    const basePrice: GasPrice = { maxFeePerGas: 99n, maxPriorityFeePerGas: 9n };
    const observed: GasPrice[] = [];

    jest.spyOn(L1TxUtils.prototype, 'sendTransaction').mockImplementation(async function (this: RelayerL1TxUtils) {
      observed.push(await this.getGasPrice());
      return { txHash: '0x1' as Hex, state: { nonce: 0, status: TxUtilsState.SENT } as L1TxState };
    });
    stubBaseMonitorTransaction();
    // The wrapper falls through to super.getGasPrice() (ReadOnlyL1TxUtils) once the override is
    // cleared; stub it here so it does not hit a real client.
    jest.spyOn(Object.getPrototypeOf(L1TxUtils.prototype), 'getGasPrice').mockResolvedValue(basePrice as never);

    const wrapper = makeWrapper();
    const otherPrice: GasPrice = { maxFeePerGas: 20n, maxPriorityFeePerGas: 2n };

    await Promise.all([
      wrapper.sendTransactionWithGasPrice(request, undefined, gasPrice),
      wrapper.sendTransaction(request),
      wrapper.sendTransactionWithGasPrice(request, undefined, otherPrice),
    ]);

    expect(observed).toEqual([gasPrice, basePrice, otherPrice]);
    expect(await wrapper.getGasPrice()).toBe(basePrice);
  });

  it('does not leak an in-flight pinned price to concurrent repricing calls', async () => {
    const basePrice: GasPrice = { maxFeePerGas: 99n, maxPriorityFeePerGas: 9n };
    let releaseSend: () => void;
    const sendGate = new Promise<void>(resolve => (releaseSend = resolve));
    const observedInSend: GasPrice[] = [];

    jest.spyOn(L1TxUtils.prototype, 'sendTransaction').mockImplementation(async function (this: RelayerL1TxUtils) {
      observedInSend.push(await this.getGasPrice());
      await sendGate;
      return { txHash: '0x1' as Hex, state: { nonce: 0, status: TxUtilsState.SENT } as L1TxState };
    });
    stubBaseMonitorTransaction();
    jest.spyOn(Object.getPrototypeOf(L1TxUtils.prototype), 'getGasPrice').mockResolvedValue(basePrice as never);

    const wrapper = makeWrapper();
    const sendPromise = wrapper.sendTransactionWithGasPrice(request, undefined, gasPrice);
    await sleep(0); // let the queued send start and read its pinned price

    // A speed-up repricing call (attempt > 0) must see the market price, not this send's pin.
    await expect(wrapper.getGasPrice(undefined, false, 1, basePrice)).resolves.toBe(basePrice);

    releaseSend!();
    await sendPromise;
    expect(observedInSend).toEqual([gasPrice]);
  });

  it('pins the price for the send and resolves the receipt through settled', async () => {
    const monitorSpy = stubBaseMonitorTransaction();
    const observed: GasPrice[] = [];
    const state = { nonce: 0, status: TxUtilsState.SENT } as L1TxState;
    jest.spyOn(L1TxUtils.prototype, 'sendTransaction').mockImplementation(async function (this: RelayerL1TxUtils) {
      observed.push(await this.getGasPrice());
      return { txHash: '0xabc' as Hex, state };
    });
    const wrapper = makeWrapper();

    const sent = await wrapper.sendTransactionWithGasPrice(request, undefined, gasPrice);

    expect(observed).toEqual([gasPrice]);
    expect(monitorSpy).toHaveBeenCalledTimes(1);
    expect(monitorSpy).toHaveBeenCalledWith(state);
    expect(sent.state).toBe(state);
    await expect(sent.settled).resolves.toBe(receipt);
  });

  it('does not wedge the queue when a queued send rejects', async () => {
    const spy = jest
      .spyOn(L1TxUtils.prototype, 'sendTransaction')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ txHash: '0xdead' as Hex, state: { nonce: 0, status: TxUtilsState.SENT } as L1TxState });
    stubBaseMonitorTransaction();
    const wrapper = makeWrapper();

    const first = wrapper.sendTransaction(request);
    const second = wrapper.sendTransaction(request);

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toMatchObject({ state: { nonce: 0 } });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
