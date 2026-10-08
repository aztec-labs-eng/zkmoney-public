import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { assertSimulateV1Supported, readUnderlyingToken, selectPayoutTokens } from './main.js';

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

describe('selectPayoutTokens', () => {
  const entryToken = EthAddress.random();
  const dai = EthAddress.random();
  const sUsds = EthAddress.random();

  /** Answers `decimals()` from `decimalsOf`, 18 by default, and records each token it reads. */
  function fakeClient(read: EthAddress[], decimalsOf: (token: EthAddress) => number = () => 18) {
    return {
      readContract: ({ address, functionName }: { address: string; functionName: string }) => {
        expect(functionName).toBe('decimals');
        const token = EthAddress.fromString(address);
        read.push(token);
        return Promise.resolve(decimalsOf(token));
      },
    } as unknown as Parameters<typeof selectPayoutTokens>[0];
  }

  it('defaults to the token of the manifest entry and checks its decimals', async () => {
    const read: EthAddress[] = [];
    await expect(selectPayoutTokens(fakeClient(read), undefined, { token: entryToken })).resolves.toEqual([entryToken]);
    expect(read).toEqual([entryToken]);
  });

  it('takes the configured tokens in place of the entry token and checks the decimals of each', async () => {
    const read: EthAddress[] = [];
    await expect(selectPayoutTokens(fakeClient(read), [dai, sUsds], { token: entryToken })).resolves.toEqual([
      dai,
      sUsds,
    ]);
    expect(read).toEqual([dai, sUsds]);
  });

  it('fails startup when the entry token does not have 18 decimals', async () => {
    await expect(
      selectPayoutTokens(
        fakeClient([], () => 6),
        undefined,
        { token: entryToken },
      ),
    ).rejects.toThrow(
      `payout token ${entryToken.toString()} has 6 decimals; the relayer prices payouts as 18-decimal USD`,
    );
  });

  it('fails startup when one configured token does not have 18 decimals', async () => {
    const decimalsOf = (token: EthAddress) => (token.equals(sUsds) ? 6 : 18);
    await expect(selectPayoutTokens(fakeClient([], decimalsOf), [dai, sUsds], { token: entryToken })).rejects.toThrow(
      `payout token ${sUsds.toString()} has 6 decimals`,
    );
  });
});

describe('readUnderlyingToken', () => {
  const underlying = EthAddress.random();
  const portal = { getUnderlying: () => Promise.resolve(underlying) };
  const clientWithDecimals = (decimals: number) =>
    ({ readContract: () => Promise.resolve(decimals) }) as unknown as Parameters<typeof readUnderlyingToken>[0];

  it('returns an 18-decimal portal underlying and reads only that token', async () => {
    const read: string[] = [];
    const client = {
      readContract: ({ address, functionName }: { address: string; functionName: string }) => {
        read.push(`${functionName}@${EthAddress.fromString(address).toString()}`);
        return Promise.resolve(18);
      },
    } as unknown as Parameters<typeof readUnderlyingToken>[0];
    await expect(readUnderlyingToken(client, portal)).resolves.toEqual(underlying);
    expect(read).toEqual([`decimals@${underlying.toString()}`]);
  });

  it('fails startup on a portal underlying with other decimals', async () => {
    await expect(readUnderlyingToken(clientWithDecimals(6), portal)).rejects.toThrow(
      `portal underlying ${underlying.toString()} has 6 decimals; the relayer prices payouts as 18-decimal USD`,
    );
  });
});
