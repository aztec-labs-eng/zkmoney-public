import { EthAddress } from '@aztec/foundation/eth-address';

import { priceFeedForChainId, readUsdPerEth, weiToUSD } from '@oxide/oxide-client/eth_usd_price_feed.js';

import type { PublicClient } from 'viem';

export { priceFeedForChainId };

export interface ChainlinkPriceOracleOptions {
  /** The L1 chain to price on; picks the ETH/USD feed out of {@link priceFeedForChainId}. */
  chainId: bigint;
}

/** Price oracle backed by a Chainlink ETH/USD feed. */
export class ChainlinkPriceOracle {
  /** The feed this oracle prices with, resolved from the chain id. */
  public readonly feed: EthAddress;

  constructor(
    private readonly client: Pick<PublicClient, 'readContract' | 'getBlock'>,
    options: ChainlinkPriceOracleOptions,
  ) {
    this.feed = priceFeedForChainId(options.chainId);
  }

  /** The USD value of `wei`, scaled to 18 decimals. Rounds up. Throws on a non-positive or stale feed answer. */
  async weiToUSD(wei: bigint): Promise<bigint> {
    return weiToUSD(wei, await readUsdPerEth(this.client, this.feed));
  }
}
