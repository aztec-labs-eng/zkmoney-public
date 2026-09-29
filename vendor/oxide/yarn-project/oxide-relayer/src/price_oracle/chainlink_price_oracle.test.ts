import { EthAddress } from '@aztec/foundation/eth-address';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ChainlinkPriceOracle, priceFeedForChainId } from './chainlink_price_oracle.js';

const USD_PER_ETH = 3_000n * 10n ** 8n; // $3000 at the 8 decimals every ETH/USD feed answers with
const MAINNET_CHAIN_ID = 1n;
const HOUR = 60n * 60n;
/** The timestamp of the L1 block the oracle ages the feed answer against; the tests move it, not the wall clock. */
const L1_TIMESTAMP = 1_700_000_000n;

describe('ChainlinkPriceOracle', () => {
  let answer: bigint;
  let updatedAt: bigint;
  let l1Timestamp: bigint;
  let readContract: jest.Mock<(args: { address: string; functionName: string }) => Promise<unknown>>;
  let client: any;

  const makeOracle = () => new ChainlinkPriceOracle(client, { chainId: MAINNET_CHAIN_ID });

  beforeEach(() => {
    answer = USD_PER_ETH;
    l1Timestamp = L1_TIMESTAMP;
    updatedAt = L1_TIMESTAMP;
    readContract = jest.fn(({ functionName }: { address: string; functionName: string }) => {
      if (functionName === 'latestRoundData') {
        return Promise.resolve([1n, answer, 0n, updatedAt, 1n]);
      }
      throw new Error(`unexpected readContract ${functionName}`);
    });
    client = {
      readContract,
      getBlock: jest.fn(() => Promise.resolve({ timestamp: l1Timestamp })),
    };
  });

  describe('weiToUSD', () => {
    it('converts wei to USD-18 with the DepositSubsidy formula', async () => {
      // 1 ETH at $3000 is 3000 USD, i.e. 3000e18 — which is also 3000 units of the 18-decimal USD-pegged token.
      await expect(makeOracle().weiToUSD(10n ** 18n)).resolves.toBe(3_000n * 10n ** 18n);
    });

    it('rounds a sub-unit remainder up', async () => {
      // A price with a sub-cent tail leaves a remainder on 1 wei, which the ceiling keeps as a full unit.
      answer = USD_PER_ETH + 1n;
      await expect(makeOracle().weiToUSD(1n)).resolves.toBe(3_001n);
    });

    it('keeps the per-unit price of one wei non-zero, as callers that quote per-unit prices require', async () => {
      await expect(makeOracle().weiToUSD(1n)).resolves.toBe(3_000n);
    });

    it('throws on a non-positive feed answer', async () => {
      answer = 0n;
      await expect(makeOracle().weiToUSD(10n ** 18n)).rejects.toThrow(/refusing to price/);
      answer = -1n;
      await expect(makeOracle().weiToUSD(10n ** 18n)).rejects.toThrow(/refusing to price/);
    });

    it('ages the answer against the L1 timestamp, not the wall clock', async () => {
      // Fresh by wall clock, 2h old by L1 time: the L1 clock is the one `updatedAt` is on, so this is stale.
      updatedAt = BigInt(Math.floor(Date.now() / 1000));
      l1Timestamp = updatedAt + 2n * HOUR;
      await expect(makeOracle().weiToUSD(10n ** 18n)).rejects.toThrow(/stale/);
    });

    it('takes the max price age as its boundary, as the subsidy contracts do', async () => {
      updatedAt = l1Timestamp - HOUR; // exactly the 1h max age, which the `>` comparison still calls fresh
      await expect(makeOracle().weiToUSD(10n ** 18n)).resolves.toBe(3_000n * 10n ** 18n);

      updatedAt -= 1n;
      await expect(makeOracle().weiToUSD(10n ** 18n)).rejects.toThrow(/stale/);
    });

    it('reads an answer from a block after the one it aged against as fresh', async () => {
      updatedAt = l1Timestamp + 12n; // the feed updated in the next block, so the age is negative
      await expect(makeOracle().weiToUSD(10n ** 18n)).resolves.toBe(3_000n * 10n ** 18n);
    });
  });

  describe('priceFeedForChainId', () => {
    it('resolves the canonical feed per chain', () => {
      expect(priceFeedForChainId(1n)).toEqual(EthAddress.fromString('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'));
      expect(priceFeedForChainId(11155111n)).toEqual(
        EthAddress.fromString('0x694AA1769357215DE4FAC081bf1f309aDC325306'),
      );
    });

    it('falls back to the mainnet feed on a chain without its own', () => {
      expect(priceFeedForChainId(31337n)).toEqual(priceFeedForChainId(1n));
    });
  });
});
