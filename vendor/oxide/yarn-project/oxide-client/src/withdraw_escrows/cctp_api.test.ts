import { EthAddress } from '@aztec/foundation/eth-address';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { CCTP_API_URL, fetchCctpFees, fetchCctpMessages } from './cctp_api.js';
import { cctpEvmDestination, hyperCoreDestination } from './cctp_bridge.js';

const TX_HASH = `0x${'ab'.repeat(32)}` as const;

let fetchSpy: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchCctpFees', () => {
  it('reads the forwarded fees of each finality threshold', async () => {
    respondWith(200, [
      { finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 112666, med: 124232, high: 135797 } },
      { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 112666, med: 124232, high: 135797 } },
    ]);

    const fees = await fetchCctpFees(cctpEvmDestination('hyperEvm'));

    expect(fetchSpy.mock.calls[0][0]).toBe(`${CCTP_API_URL}/v2/burn/USDC/fees/0/19?forward=true`);
    expect(fees).toEqual([
      { finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 112666n, med: 124232n, high: 135797n } },
      { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 112666n, med: 124232n, high: 135797n } },
    ]);
  });

  it('quotes the forward to HyperCore', async () => {
    respondWith(200, { role: 'user' });
    const destination = await hyperCoreDestination(EthAddress.random());
    respondWith(200, []);

    await fetchCctpFees(destination);

    expect(fetchSpy.mock.calls[1][0]).toBe(`${CCTP_API_URL}/v2/burn/USDC/fees/0/19?forward=true&hyperCoreDeposit=true`);
  });

  it('keeps an entry that has no forwarding fee', async () => {
    respondWith(200, [{ finalityThreshold: 1000, minimumFee: 1 }]);

    await expect(fetchCctpFees(cctpEvmDestination('base'))).resolves.toEqual([
      { finalityThreshold: 1000, minimumFee: 1, forwardFee: undefined },
    ]);
  });

  it('throws on an error status', async () => {
    respondWith(500, {});

    await expect(fetchCctpFees(cctpEvmDestination('base'))).rejects.toThrow('CCTP fees returned 500');
  });
});

describe('fetchCctpMessages', () => {
  it('reads the forward state of the burn at the given base URL', async () => {
    respondWith(200, {
      messages: [
        {
          status: 'complete',
          forwardState: 'COMPLETE',
          forwardTxHash: TX_HASH,
          delayReason: null,
          attestation: '0x',
        },
      ],
    });

    const messages = await fetchCctpMessages(TX_HASH, { baseUrl: 'https://iris.test' });

    expect(fetchSpy.mock.calls[0][0]).toBe(`https://iris.test/v2/messages/0?transactionHash=${TX_HASH}`);
    expect(messages).toEqual([
      {
        status: 'complete',
        forwardState: 'COMPLETE',
        forwardTxHash: TX_HASH,
        forwardErrorCode: null,
        delayReason: null,
      },
    ]);
  });

  it('returns undefined while Circle has not indexed the burn', async () => {
    respondWith(404, { error: 'Message not found for provided parameters' });

    await expect(fetchCctpMessages(TX_HASH)).resolves.toBeUndefined();
  });

  it('throws on an error status', async () => {
    respondWith(429, {});

    await expect(fetchCctpMessages(TX_HASH)).rejects.toThrow('CCTP messages returned 429');
  });
});

function respondWith(status: number, body: unknown) {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}
