import type { ExtensiblePriceOracle } from './price_oracle.js';

const ONE_USD = 10n ** 18n;

/**
 * A price oracle for tests only: ETH at `usdPerEth` whole USD, and each token at one USD with 18 decimals. At the
 * default of one USD per ETH, the gas cost in a token is the gas cost in wei. Do not use it in production.
 */
export function fixedPriceOracle(usdPerEth = 1n): ExtensiblePriceOracle {
  return {
    addToken: () => Promise.resolve(),
    getEthPrice: () => Promise.resolve(usdPerEth * ONE_USD),
    getTokenPrice: () => Promise.resolve({ usdPerToken: ONE_USD, decimals: 18 }),
  };
}
