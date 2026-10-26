import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { ETH_USD_FEED_DECIMALS, priceFeedForChainId, readUsdPerEth } from '@oxide/oxide-client/eth_usd_price_feed.js';

import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type PublicClient,
  erc20Abi,
  erc4626Abi,
} from 'viem';

import { type ExtensiblePriceOracle, type TokenPrice, USD_DECIMALS, tokenToUsd } from './price_oracle.js';

/** How the oracle values a token, decided once, when the oracle is created. */
type Route =
  | { kind: 'usd-token'; decimals: number }
  | {
      kind: 'usd-vault-share';
      /** Decimals of the vault share, which set the share that `convertToAssets` is asked about. */
      decimals: number;
      assetDecimals: number;
    };

export interface UsdPeggedPriceOracleOptions {
  /** The L1 chain to price on. It selects the ETH/USD feed. */
  chainId: bigint;
  /** The tokens the oracle prices from the start. Each is classified when the oracle is created. */
  tokens: readonly EthAddress[];
}

const ONE_USD = 10n ** BigInt(USD_DECIMALS);

/**
 * Prices gas with the chain's Chainlink ETH/USD feed, and each token without a market price:
 * - a USD token, for example DAI, at one USD per whole token;
 * - an ERC-4626 vault share whose asset is a USD token, for example sUSDS over USDS, at the assets that the vault
 *   converts it to, each whole asset at one USD. The vault rate is read on every price, so yield shows at once.
 *
 * A token that answers `asset()` is a vault share; a token whose `asset()` reverts is a USD token. The oracle trusts
 * that each token, or the asset of each vault share, is worth one USD. Only add a token that is known to be one.
 *
 * TODO(leila): the price feed follow-up replaces it with an oracle that prices each token with a feed.
 */
export class UsdPeggedPriceOracle implements ExtensiblePriceOracle {
  private constructor(
    private readonly client: Pick<PublicClient, 'readContract' | 'getBlock'>,
    private readonly ethUsdFeed: EthAddress,
    /** Lower-case token address to its route. `addToken` adds to it. */
    private readonly routes: Map<string, Route>,
  ) {}

  /** Create the oracle and classify every token in `options.tokens`. Throws when one cannot be classified. */
  static async create(
    client: Pick<PublicClient, 'readContract' | 'getBlock'>,
    options: UsdPeggedPriceOracleOptions,
  ): Promise<UsdPeggedPriceOracle> {
    const routes = await Promise.all(
      options.tokens.map(async token => [key(token), await classify(client, token)] as const),
    );
    return new UsdPeggedPriceOracle(client, priceFeedForChainId(options.chainId), new Map(routes));
  }

  async addToken(token: EthAddress): Promise<void> {
    if (this.routes.has(key(token))) {
      return;
    }
    this.routes.set(key(token), await classify(this.client, token));
  }

  /** USD per ETH, scaled to 18 decimals. */
  async getEthPrice(): Promise<bigint> {
    const answer = await readUsdPerEth(this.client, this.ethUsdFeed);
    return answer * 10n ** (BigInt(USD_DECIMALS) - ETH_USD_FEED_DECIMALS);
  }

  async getTokenPrice(token: EthAddress): Promise<TokenPrice> {
    const route = this.routes.get(key(token));
    if (!route) {
      throw new Error(`token ${token} has no price: add it to the oracle first`);
    }
    if (route.kind === 'usd-token') {
      return { usdPerToken: ONE_USD, decimals: route.decimals };
    }
    const assetsPerShare = await this.client.readContract({
      address: token.toString(),
      abi: erc4626Abi,
      functionName: 'convertToAssets',
      args: [10n ** BigInt(route.decimals)],
    });
    const usdPerToken = tokenToUsd(assetsPerShare, { usdPerToken: ONE_USD, decimals: route.assetDecimals });
    return { usdPerToken, decimals: route.decimals };
  }

  /** One line for each priced token, for a startup log. */
  describe(): string[] {
    return [...this.routes].map(([token, route]) =>
      route.kind === 'usd-token'
        ? `${token} priced as a USD token at one USD`
        : `${token} priced as an ERC-4626 share of a USD token, at the vault rate`,
    );
  }
}

async function classify(client: Pick<PublicClient, 'readContract'>, token: EthAddress): Promise<Route> {
  const asset = await readVaultAsset(client, token);
  if (asset === undefined) {
    return { kind: 'usd-token', decimals: await readDecimals(client, token) };
  }
  if (asset.equals(token)) {
    throw new Error(`cannot price token ${token}: it names itself as its ERC-4626 asset`);
  }
  const [decimals, assetDecimals] = await Promise.all([readDecimals(client, token), readDecimals(client, asset)]);
  return { kind: 'usd-vault-share', decimals, assetDecimals };
}

function readDecimals(client: Pick<PublicClient, 'readContract'>, token: EthAddress): Promise<number> {
  return client.readContract({ address: token.toString(), abi: erc20Abi, functionName: 'decimals' });
}

/**
 * The asset of `token` if it is an ERC-4626 vault, or undefined if `asset()` reverts. Any other error, for example an
 * RPC failure, throws, so a failed read never decides how a token is priced.
 */
async function readVaultAsset(
  client: Pick<PublicClient, 'readContract'>,
  token: EthAddress,
): Promise<EthAddress | undefined> {
  try {
    const asset = await client.readContract({ address: token.toString(), abi: erc4626Abi, functionName: 'asset' });
    return EthAddress.fromString(asset);
  } catch (error) {
    const reverted =
      error instanceof BaseError &&
      error.walk(
        cause => cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError,
      );
    if (reverted) {
      return undefined;
    }
    throw error;
  }
}

function key(token: EthAddress): string {
  return token.toString().toLowerCase();
}
