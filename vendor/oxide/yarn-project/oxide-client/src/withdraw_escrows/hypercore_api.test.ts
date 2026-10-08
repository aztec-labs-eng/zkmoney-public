import { EthAddress } from '@aztec/foundation/eth-address';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { HYPERLIQUID_API_URL, fetchHyperCoreAccountExists } from './hypercore_api.js';

const ACCOUNT = EthAddress.fromString('0xE100cf9c1d7a96a7790Cb54b86658572C755aB2F');

let fetchSpy: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchHyperCoreAccountExists', () => {
  it('asks the Hyperliquid info API for the role of the account', async () => {
    respondWith(200, { role: 'user' });

    await expect(fetchHyperCoreAccountExists(ACCOUNT)).resolves.toBe(true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${HYPERLIQUID_API_URL}/info`);
    expect(JSON.parse(init!.body as string)).toEqual({ type: 'userRole', user: ACCOUNT.toString() });
  });

  it('reports a missing account at the given base URL', async () => {
    respondWith(200, { role: 'missing' });

    await expect(fetchHyperCoreAccountExists(ACCOUNT, { baseUrl: 'https://hl.test' })).resolves.toBe(false);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://hl.test/info');
  });

  it('throws on an error status', async () => {
    respondWith(500, {});

    await expect(fetchHyperCoreAccountExists(ACCOUNT)).rejects.toThrow('Hyperliquid userRole returned 500');
  });
});

function respondWith(status: number, body: unknown) {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}
