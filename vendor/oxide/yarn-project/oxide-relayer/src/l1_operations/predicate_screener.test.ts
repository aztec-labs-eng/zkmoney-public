import { EthAddress } from '@aztec/foundation/eth-address';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { PredicateScreener, PredicateScreenerConfig } from './predicate_screener.js';

const CONFIG: PredicateScreenerConfig = {
  apiKey: 'test-key',
  verificationHash: 'x-managed-policy-abc',
  chain: 'ethereum-mainnet',
};

const ADDRESS = EthAddress.fromString('0xaabbccddeeff00112233445566778899aabbccdd');

const nowSec = () => Math.floor(Date.now() / 1000);

function attestationResponse(
  isCompliant: boolean,
  expirationSec: number,
  init: { ok?: boolean; status?: number } = {},
) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    // eslint-disable-next-line camelcase
    json: () => Promise.resolve({ is_compliant: isCompliant, attestation: { expiration: expirationSec } }),
  } as unknown as Response;
}

describe('PredicateScreener', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns true for a compliant recipient', async () => {
    fetchSpy.mockResolvedValue(attestationResponse(true, nowSec() + 3600));
    const screener = new PredicateScreener(CONFIG);
    expect(await screener.isCompliant(ADDRESS)).toBe(true);
  });

  it('returns false for a non-compliant recipient', async () => {
    fetchSpy.mockResolvedValue(attestationResponse(false, nowSec() + 3600));
    const screener = new PredicateScreener(CONFIG);
    expect(await screener.isCompliant(ADDRESS)).toBe(false);
  });

  it('sends the api key, verification hash, recipient, and chain', async () => {
    fetchSpy.mockResolvedValue(attestationResponse(true, nowSec() + 3600));
    await new PredicateScreener(CONFIG).isCompliant(ADDRESS);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.predicate.io/v2/attestation');
    expect((init!.headers as Record<string, string>)['x-api-key']).toBe('test-key');
    expect(JSON.parse(init!.body as string)).toEqual({
      // eslint-disable-next-line camelcase
      verification_hash: 'x-managed-policy-abc',
      from: ADDRESS.toString(),
      chain: 'ethereum-mainnet',
    });
  });

  it('caches a verdict until the attestation expires', async () => {
    fetchSpy.mockResolvedValue(attestationResponse(true, nowSec() + 3600));
    const screener = new PredicateScreener(CONFIG);

    expect(await screener.isCompliant(ADDRESS)).toBe(true);
    expect(await screener.isCompliant(ADDRESS)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-queries once the cached attestation has expired', async () => {
    fetchSpy.mockResolvedValue(attestationResponse(true, nowSec() - 1));
    const screener = new PredicateScreener(CONFIG);

    expect(await screener.isCompliant(ADDRESS)).toBe(true);
    expect(await screener.isCompliant(ADDRESS)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws and does not cache on a non-ok response', async () => {
    fetchSpy.mockResolvedValue(attestationResponse(true, nowSec() + 3600, { ok: false, status: 500 }));
    const screener = new PredicateScreener(CONFIG);

    await expect(screener.isCompliant(ADDRESS)).rejects.toThrow(/500/);
    // Not cached: the next call retries the API.
    await expect(screener.isCompliant(ADDRESS)).rejects.toThrow(/500/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws when the request fails', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const screener = new PredicateScreener(CONFIG);
    await expect(screener.isCompliant(ADDRESS)).rejects.toThrow(/network down/);
  });
});
