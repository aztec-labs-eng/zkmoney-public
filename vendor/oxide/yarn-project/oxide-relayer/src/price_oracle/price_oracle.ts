import type { EthAddress } from '@aztec/foundation/eth-address';

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

/** The USD value of `wei` at `ethPrice`, USD per ETH scaled to 18 decimals. Rounds up, as a cost must. */
export function weiToUsd(wei: bigint, ethPrice: bigint): bigint {
  return (wei * ethPrice + USD_SCALE - 1n) / USD_SCALE;
}

/** The USD value of `amount` units of a token at `price`, scaled to 18 decimals. Rounds down, as a reward must. */
export function tokenToUsd(amount: bigint, price: TokenPrice): bigint {
  return (amount * price.usdPerToken) / 10n ** BigInt(price.decimals);
}
