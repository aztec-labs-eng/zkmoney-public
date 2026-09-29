import type { ViemClient } from '@aztec/ethereum/types';
import { EthAddress } from '@aztec/foundation/eth-address';

/** The read surface of a Chainlink AggregatorV3Interface feed, kept local so this file has no artifact imports. */
const AGGREGATOR_V3_READ_ABI = [
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

export interface ChainlinkPriceOracleOptions {
  /** The L1 chain to price on; picks the ETH/USD feed out of {@link priceFeedForChainId}. */
  chainId: bigint;
}

/** Max age of a feed answer before it is rejected as stale. */
const MAX_PRICE_AGE_SECONDS = 60n * 60n;

/**
 * The canonical Chainlink ETH/USD proxy per chain — the same table the shared-L1 deploy binds the subsidy
 * contracts to (infra/scripts/shared-l1.sh), so the oracle prices with the feed the subsidy contracts price with.
 */
const FEED_BY_CHAIN_ID: Record<string, string> = {
  '1': '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  '11155111': '0x694AA1769357215DE4FAC081bf1f309aDC325306',
};

/** Every ETH/USD feed in {@link FEED_BY_CHAIN_ID} answers with 8 decimals, so the scale is not read on-chain. */
const FEED_DECIMALS = 8n;

/** A chain without its own feed — a local devnet — prices with the mainnet address, where its tests put a stub. */
export function priceFeedForChainId(chainId: bigint): EthAddress {
  return EthAddress.fromString(FEED_BY_CHAIN_ID[chainId.toString()] ?? FEED_BY_CHAIN_ID['1']);
}

/** Price oracle backed by a Chainlink ETH/USD feed. */
export class ChainlinkPriceOracle {
  /** The feed this oracle prices with, resolved from the chain id. */
  public readonly feed: EthAddress;

  constructor(
    private readonly client: ViemClient,
    options: ChainlinkPriceOracleOptions,
  ) {
    this.feed = priceFeedForChainId(options.chainId);
  }

  /** The USD value of `wei`, scaled to 18 decimals. Rounds up. */
  async weiToUSD(wei: bigint): Promise<bigint> {
    const usdPerEth = await this.#readUsdPerEth();
    // wei is already 18-decimal, so USD-18 = wei * usdPerEth / 10**FEED_DECIMALS.
    const denominator = 10n ** FEED_DECIMALS;
    return (wei * usdPerEth + denominator - 1n) / denominator;
  }

  /** The latest ETH/USD answer, scaled by `10**feedDecimals`. Throws on a non-positive or stale answer. */
  async #readUsdPerEth(): Promise<bigint> {
    const [[, answer, , updatedAt], { timestamp: l1Timestamp }] = await Promise.all([
      this.client.readContract({
        address: this.feed.toString(),
        abi: AGGREGATOR_V3_READ_ABI,
        functionName: 'latestRoundData',
      }),
      this.client.getBlock({ blockTag: 'latest', includeTransactions: false }),
    ]);
    if (answer <= 0n) {
      throw new Error(`price feed ${this.feed} answered ${answer}; refusing to price with it`);
    }

    const ageSeconds = l1Timestamp - updatedAt;
    if (ageSeconds > MAX_PRICE_AGE_SECONDS) {
      throw new Error(
        `price feed ${this.feed} is stale: answer is ${ageSeconds}s old, max age is ${MAX_PRICE_AGE_SECONDS}s`,
      );
    }
    return answer;
  }
}
