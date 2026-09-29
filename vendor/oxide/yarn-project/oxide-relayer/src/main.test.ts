import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { assertSimulateV1Supported, readPayoutToken } from './main.js';

const READ_RPC_URL = 'https://eth-mainnet.example.com/v2/secret-api-key';

function clientAnsweringWith(outcome: Promise<unknown>) {
  return { simulateBlocks: () => outcome } as unknown as Parameters<typeof assertSimulateV1Supported>[0];
}

describe('assertSimulateV1Supported', () => {
  it('passes when the read RPC answers the probe', async () => {
    await expect(
      assertSimulateV1Supported(clientAnsweringWith(Promise.resolve([{ calls: [] }])), READ_RPC_URL),
    ).resolves.toBeUndefined();
  });

  it('fails startup on a method-not-found error, naming the host but not the URL', async () => {
    const error = Object.assign(new Error('the method eth_simulateV1 does not exist/is not available'), {
      code: -32601,
    });
    await expect(assertSimulateV1Supported(clientAnsweringWith(Promise.reject(error)), READ_RPC_URL)).rejects.toThrow(
      'l1-operations mode needs a read RPC that supports eth_simulateV1; eth-mainnet.example.com answered: ' +
        'the method eth_simulateV1 does not exist/is not available',
    );
    await expect(
      assertSimulateV1Supported(clientAnsweringWith(Promise.reject(error)), READ_RPC_URL),
    ).rejects.not.toThrow('secret-api-key');
  });

  it('fails startup on a plain-text HTTP error', async () => {
    await expect(
      assertSimulateV1Supported(
        clientAnsweringWith(Promise.reject(new Error('HTTP request failed. Status: 403 only core evm requests'))),
        READ_RPC_URL,
      ),
    ).rejects.toThrow('eth-mainnet.example.com answered: HTTP request failed. Status: 403 only core evm requests');
  });
});

describe('readPayoutToken', () => {
  const token = EthAddress.random();
  const portal = { getUnderlying: () => Promise.resolve(token) };

  function clientWithDecimals(decimals: number) {
    return { readContract: () => Promise.resolve(decimals) } as unknown as Parameters<typeof readPayoutToken>[0];
  }

  it('returns an 18-decimal portal underlying', async () => {
    await expect(readPayoutToken(clientWithDecimals(18), portal)).resolves.toEqual(token);
  });

  it('fails startup on a portal underlying with other decimals', async () => {
    await expect(readPayoutToken(clientWithDecimals(6), portal)).rejects.toThrow(
      `portal underlying ${token.toString()} has 6 decimals; the relayer prices payouts as 18-decimal USD`,
    );
  });
});
