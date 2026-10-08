import { EthAddress } from '@aztec/foundation/eth-address';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ACROSS_API_URL, fetchAcrossDepositStatus, fetchAcrossFees } from './across_api.js';
import type { AcrossBridgeQuoteArgs } from './across_bridge.js';

const USDT = EthAddress.fromString('0xdAC17F958D2ee523a2206206994597C13D831ec7');
const BNB_USDT = EthAddress.fromString('0x55d398326f99059fF775485246999027B3197955');
const TX_HASH = `0x${'ab'.repeat(32)}` as const;
const FILL_TX_HASH = `0x${'cd'.repeat(32)}` as const;

let fetchSpy: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchAcrossFees', () => {
  it('prices the deposit of a 1:1 swap on the route', async () => {
    respondWith(200, {
      totalRelayFee: { pct: '482399961131310', total: '1205999' },
      relayerGasFee: { pct: '1507684386858', total: '3769' },
      limits: { minDeposit: '500091', maxDeposit: '100000000000' },
      outputToken: { address: BNB_USDT.toString(), decimals: 18 },
    });

    const fees = await fetchAcrossFees(quoteArgs(2_503n * 10n ** 18n, 3n * 10n ** 18n));

    expect(fetchSpy.mock.calls[0][0]).toBe(
      `${ACROSS_API_URL}/suggested-fees?inputToken=${USDT}&outputToken=${BNB_USDT}` +
        `&originChainId=1&destinationChainId=56&amount=2500000000&allowUnmatchedDecimals=true`,
    );
    expect(fees).toEqual({
      totalRelayFeePct: 482_399_961_131_310n,
      relayerGasFeePct: 1_507_684_386_858n,
      relayerGasFee: 3_769n,
      acrossOutputTokenDecimals: 18,
      minDeposit: 500_091n,
      maxDeposit: 100_000_000_000n,
    });
  });

  it('throws with the Across reason on an error status', async () => {
    respondWith(400, { code: 'ROUTE_NOT_ENABLED', message: 'Route is not enabled.' });

    await expect(fetchAcrossFees(quoteArgs(100n * 10n ** 18n))).rejects.toThrow(
      'Across suggested-fees returned 400: Route is not enabled.',
    );
  });

  it('throws on an error status with no JSON body', async () => {
    fetchSpy.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    await expect(fetchAcrossFees(quoteArgs(100n * 10n ** 18n))).rejects.toThrow('Across suggested-fees returned 502');
  });
});

describe('fetchAcrossDepositStatus', () => {
  it('reads the fill of the deposit at the given base URL', async () => {
    respondWith(200, {
      status: 'filled',
      depositTxHash: TX_HASH,
      fillTx: FILL_TX_HASH,
      depositRefundTxHash: null,
      destinationChainId: 56,
    });

    const status = await fetchAcrossDepositStatus(TX_HASH, { baseUrl: 'https://across.test' });

    expect(fetchSpy.mock.calls[0][0]).toBe(
      `https://across.test/deposit/status?originChainId=1&depositTxHash=${TX_HASH}`,
    );
    expect(status).toEqual({ status: 'filled', fillTxHash: FILL_TX_HASH });
  });

  it('reads the refund of an expired deposit', async () => {
    respondWith(200, { status: 'refunded', fillTx: null, depositRefundTxHash: FILL_TX_HASH });

    await expect(fetchAcrossDepositStatus(TX_HASH)).resolves.toEqual({
      status: 'refunded',
      refundTxHash: FILL_TX_HASH,
    });
  });

  it('throws on a fill with no fill transaction', async () => {
    respondWith(200, { status: 'filled', fillTx: null, depositRefundTxHash: null });

    await expect(fetchAcrossDepositStatus(TX_HASH)).rejects.toThrow(
      'Across deposit status is filled but has no transaction hash',
    );
  });

  it('returns undefined while Across has not indexed the deposit', async () => {
    respondWith(404, {
      error: 'DepositNotFoundException',
      message: 'Deposit not found given the provided constraints',
    });

    await expect(fetchAcrossDepositStatus(TX_HASH)).resolves.toBeUndefined();
  });

  it('throws on an error status', async () => {
    respondWith(429, {});

    await expect(fetchAcrossDepositStatus(TX_HASH)).rejects.toThrow('Across deposit status returned 429');
  });
});

function quoteArgs(escrowFunding: bigint, relayerTip = 0n): AcrossBridgeQuoteArgs {
  return {
    amount: escrowFunding,
    withdrawalRelayerTip: 0n,
    proverTip: 0n,
    fpcFundingCut: 0n,
    relayerTip,
    route: {
      acrossInputToken: USDT,
      destinationChainId: 56n,
      acrossOutputToken: BNB_USDT,
      acrossOutputTokenDecimals: 18,
    },
  };
}

function respondWith(status: number, body: unknown) {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}
