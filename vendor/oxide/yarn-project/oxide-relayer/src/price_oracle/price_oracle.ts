import type { EthAddress } from '@aztec-labs/foundation/eth-address';

/** Decimals of every USD value. */
export const USD_DECIMALS = 18;

const USD_SCALE = 10n ** BigInt(USD_DECIMALS);

/** The price of one token, and the decimals that turn a token amount into whole tokens. */
export interface TokenPrice {
  /** USD per whole token, scaled to 18 decimals. */
  usdPerToken: bigint;
  /** Decimals of the token itself. */
  decimals: number;
}

/** Prices ETH and tokens in USD, scaled to 18 decimals. */
export interface PriceOracle {
  getEthPrice(): Promise<bigint>;
  getTokenPrice(token: EthAddress): Promise<TokenPrice>;
}

/** A price oracle that can add tokens to the tokens it prices while it runs. */
export interface ExtensiblePriceOracle extends PriceOracle {
  addToken(token: EthAddress): Promise<void>;
}

/** The USD value of `wei` at `ethPrice`, USD per ETH scaled to 18 decimals. Rounds up, as a cost must. */
export function weiToUsd(wei: bigint, ethPrice: bigint): bigint {
  return (wei * ethPrice + USD_SCALE - 1n) / USD_SCALE;
}

/** The USD value of `amount` units of a token at `price`, scaled to 18 decimals. Rounds down, as a reward must. */
export function tokenToUsd(amount: bigint, price: TokenPrice): bigint {
  return (amount * price.usdPerToken) / 10n ** BigInt(price.decimals);
}

/** The direction to round a division. */
export type Rounding = 'up' | 'down';

/** The units of a token that one ETH is worth. Rounds up by default. Throws when the token has no USD value. */
export function tokenUnitsPerEth(ethPrice: bigint, price: TokenPrice, rounding: Rounding = 'up'): bigint {
  if (price.usdPerToken <= 0n) {
    throw new Error(`refusing to price gas in a token worth ${price.usdPerToken} USD`);
  }
  const scaled = ethPrice * 10n ** BigInt(price.decimals);
  const remainder = rounding === 'up' ? price.usdPerToken - 1n : 0n;
  return (scaled + remainder) / price.usdPerToken;
}

/** The units of `token` that one ETH is worth, at the current prices of `oracle`. Rounds up by default. */
export async function readTokenUnitsPerEth(
  oracle: PriceOracle,
  token: EthAddress,
  rounding: Rounding = 'up',
): Promise<bigint> {
  const [ethPrice, tokenPrice] = await Promise.all([oracle.getEthPrice(), oracle.getTokenPrice(token)]);
  return tokenUnitsPerEth(ethPrice, tokenPrice, rounding);
}
