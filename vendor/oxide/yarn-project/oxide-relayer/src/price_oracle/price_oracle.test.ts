import { describe, expect, it } from '@jest/globals';

import { tokenUnitsPerEth } from './price_oracle.js';

const USD = 10n ** 18n;

describe('tokenUnitsPerEth', () => {
  it('is the ETH price in whole tokens, at the decimals of the token', () => {
    expect(tokenUnitsPerEth(3_000n * USD, { usdPerToken: USD, decimals: 18 })).toBe(3_000n * 10n ** 18n);
    expect(tokenUnitsPerEth(3_000n * USD, { usdPerToken: USD, decimals: 6 })).toBe(3_000n * 10n ** 6n);
  });

  it('charges fewer units of a token that is worth more than one USD', () => {
    // An sUSDS share at 1.05 USDS: 3000 USD buys 2857.142857... shares.
    expect(tokenUnitsPerEth(3_000n * USD, { usdPerToken: 105n * 10n ** 16n, decimals: 18 })).toBe(
      2_857_142_857_142_857_142_858n,
    );
  });

  it('rounds up by default', () => {
    expect(tokenUnitsPerEth(1n, { usdPerToken: 3n, decimals: 0 })).toBe(1n);
    expect(tokenUnitsPerEth(1n, { usdPerToken: 3n, decimals: 0 }, 'up')).toBe(1n);
  });

  it('rounds down when asked to', () => {
    expect(tokenUnitsPerEth(1n, { usdPerToken: 3n, decimals: 0 }, 'down')).toBe(0n);
    expect(tokenUnitsPerEth(3_000n * USD, { usdPerToken: 105n * 10n ** 16n, decimals: 18 }, 'down')).toBe(
      2_857_142_857_142_857_142_857n,
    );
  });

  it('refuses a token with no USD value', () => {
    expect(() => tokenUnitsPerEth(3_000n * USD, { usdPerToken: 0n, decimals: 18 })).toThrow(/refusing to price gas/);
  });
});
