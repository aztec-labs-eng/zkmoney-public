import { EthAddress } from '@aztec/foundation/eth-address';

/** The read surface of a Chainlink AggregatorV3Interface feed. */
export const AGGREGATOR_V3_READ_ABI = [
  {
    type: 'function',
    name: 'latestRoundData',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
  },
] as const;

/** Max age of a feed answer before it is rejected as stale. */
export const ETH_USD_MAX_PRICE_AGE_SECONDS = 60n * 60n;

/**
 * The canonical Chainlink ETH/USD proxy per chain — the same table the shared-L1 deploy binds the subsidy
 * contracts to (infra/scripts/shared-l1.sh), so the oracle prices with the feed the subsidy contracts price with.
 */
export const ETH_USD_FEED_BY_CHAIN_ID: Readonly<Record<string, `0x${string}`>> = {
  '1': '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  '11155111': '0x694AA1769357215DE4FAC081bf1f309aDC325306',
};

/** Every ETH/USD feed in {@link ETH_USD_FEED_BY_CHAIN_ID} answers with 8 decimals, so the scale is not read on-chain. */
export const ETH_USD_FEED_DECIMALS = 8n;

/** The L1 client reads the feed needs. A viem public client satisfies it. */
export interface EthUsdPriceFeedClient {
  readContract(args: {
    address: `0x${string}`;
    abi: typeof AGGREGATOR_V3_READ_ABI;
    functionName: 'latestRoundData';
  }): Promise<readonly [bigint, bigint, bigint, bigint, bigint]>;
  getBlock(args: { blockTag: 'latest'; includeTransactions: false }): Promise<{ timestamp: bigint }>;
}

/** A chain without its own feed — a local devnet — prices with the mainnet address, where its tests put a stub. */
export function priceFeedForChainId(chainId: bigint): EthAddress {
  return EthAddress.fromString(ETH_USD_FEED_BY_CHAIN_ID[chainId.toString()] ?? ETH_USD_FEED_BY_CHAIN_ID['1']);
}

/** The USD value of `wei`, scaled to 18 decimals, at `usdPerEth` (a feed answer). Rounds up. */
export function weiToUSD(wei: bigint, usdPerEth: bigint): bigint {
  // wei is already 18-decimal, so USD-18 = wei * usdPerEth / 10**FEED_DECIMALS.
  const denominator = 10n ** ETH_USD_FEED_DECIMALS;
  return (wei * usdPerEth + denominator - 1n) / denominator;
}

/**
 * The latest ETH/USD answer of `feed`, scaled by `10**ETH_USD_FEED_DECIMALS`. The answer is aged against the latest
 * L1 block timestamp. Throws on a non-positive or stale answer.
 */
export async function readUsdPerEth(client: EthUsdPriceFeedClient, feed: EthAddress): Promise<bigint> {
  const [[, answer, , updatedAt], { timestamp: l1Timestamp }] = await Promise.all([
    client.readContract({ address: feed.toString(), abi: AGGREGATOR_V3_READ_ABI, functionName: 'latestRoundData' }),
    client.getBlock({ blockTag: 'latest', includeTransactions: false }),
  ]);
  if (answer <= 0n) {
    throw new Error(`price feed ${feed} answered ${answer}; refusing to price with it`);
  }

  const ageSeconds = l1Timestamp - updatedAt;
  if (ageSeconds > ETH_USD_MAX_PRICE_AGE_SECONDS) {
    throw new Error(
      `price feed ${feed} is stale: answer is ${ageSeconds}s old, max age is ${ETH_USD_MAX_PRICE_AGE_SECONDS}s`,
    );
  }
  return answer;
}
