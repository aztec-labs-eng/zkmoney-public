import { EthAddress } from '@aztec/foundation/eth-address';

import { beforeEach, describe, expect, it } from '@jest/globals';

import {
  ETH_USD_MAX_PRICE_AGE_SECONDS,
  type EthUsdPriceFeedClient,
  priceFeedForChainId,
  readUsdPerEth,
  weiToUSD,
} from './eth_usd_price_feed.js';

const USD_PER_ETH = 3_000n * 10n ** 8n;
const L1_TIMESTAMP = 1_700_000_000n;
const FEED = priceFeedForChainId(1n);

describe('weiToUSD', () => {
  it('converts wei to USD-18', () => {
    expect(weiToUSD(10n ** 18n, USD_PER_ETH)).toBe(3_000n * 10n ** 18n);
  });

  it('rounds a sub-unit remainder up', () => {
    expect(weiToUSD(1n, USD_PER_ETH + 1n)).toBe(3_001n);
  });

  it('returns 0 for 0 wei', () => {
    expect(weiToUSD(0n, USD_PER_ETH)).toBe(0n);
  });
});

describe('readUsdPerEth', () => {
  let answer: bigint;
  let updatedAt: bigint;
  let readAddresses: string[];
  let client: EthUsdPriceFeedClient;

  beforeEach(() => {
    answer = USD_PER_ETH;
    updatedAt = L1_TIMESTAMP;
    readAddresses = [];
    client = {
      readContract: ({ address }) => {
        readAddresses.push(address);
        return Promise.resolve([1n, answer, 0n, updatedAt, 1n] as const);
      },
      getBlock: () => Promise.resolve({ timestamp: L1_TIMESTAMP }),
    };
  });

  it('returns the answer of the given feed', async () => {
    await expect(readUsdPerEth(client, FEED)).resolves.toBe(USD_PER_ETH);
    expect(readAddresses).toEqual([FEED.toString()]);
  });

  it('throws on a non-positive answer', async () => {
    answer = 0n;
    await expect(readUsdPerEth(client, FEED)).rejects.toThrow(/refusing to price/);
    answer = -1n;
    await expect(readUsdPerEth(client, FEED)).rejects.toThrow(/refusing to price/);
  });

  it('accepts an answer exactly at the max age and rejects an older one', async () => {
    updatedAt = L1_TIMESTAMP - ETH_USD_MAX_PRICE_AGE_SECONDS;
    await expect(readUsdPerEth(client, FEED)).resolves.toBe(USD_PER_ETH);
    updatedAt -= 1n;
    await expect(readUsdPerEth(client, FEED)).rejects.toThrow(/stale/);
  });

  it('accepts an answer from a block after the one it ages against', async () => {
    updatedAt = L1_TIMESTAMP + 12n;
    await expect(readUsdPerEth(client, FEED)).resolves.toBe(USD_PER_ETH);
  });
});

describe('priceFeedForChainId', () => {
  it('resolves the canonical feed per chain', () => {
    expect(priceFeedForChainId(1n)).toEqual(EthAddress.fromString('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'));
    expect(priceFeedForChainId(11155111n)).toEqual(EthAddress.fromString('0x694AA1769357215DE4FAC081bf1f309aDC325306'));
  });

  it('falls back to the mainnet feed on a chain without its own', () => {
    expect(priceFeedForChainId(31337n)).toEqual(priceFeedForChainId(1n));
  });
});
