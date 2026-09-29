import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import type { SanctionsList } from './sanctions_list.js';
import { SipaFunderScreener } from './sipa_funder_screener.js';

const SIPA = EthAddress.random();
const CLEAN_FUNDER = EthAddress.random();
const LISTED = EthAddress.random();

const TARGET = { sipa: SIPA };

const listOf = (...listed: EthAddress[]): SanctionsList => ({
  isListed: address => listed.some(l => l.equals(address)),
});

describe('SipaFunderScreener', () => {
  it('passes a SIPA whose funders are all clean', async () => {
    const screener = new SipaFunderScreener(listOf(LISTED), () => Promise.resolve([CLEAN_FUNDER]));
    expect(await screener.isSanctioned(TARGET)).toBe(false);
  });

  it('flags a SIPA with a listed funder', async () => {
    const screener = new SipaFunderScreener(listOf(LISTED), () => Promise.resolve([CLEAN_FUNDER, LISTED]));
    expect(await screener.isSanctioned(TARGET)).toBe(true);
  });

  it('propagates a funder lookup failure instead of passing', async () => {
    const screener = new SipaFunderScreener(listOf(LISTED), () => Promise.reject(new Error('rpc down')));
    await expect(screener.isSanctioned(TARGET)).rejects.toThrow('rpc down');
  });
});
