import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import type { SanctionsList } from './sanctions_list.js';
import { SipaAddressScreener } from './sipa_address_screener.js';

const SIPA = EthAddress.random();
const LISTED = EthAddress.random();

const listOf = (...listed: EthAddress[]): SanctionsList => ({
  isListed: address => listed.some(l => l.equals(address)),
});

describe('SipaAddressScreener', () => {
  it('flags a listed SIPA and passes a clean one', async () => {
    const screener = new SipaAddressScreener(listOf(LISTED));
    await expect(screener.isSanctioned({ sipa: LISTED })).resolves.toBe(true);
    await expect(screener.isSanctioned({ sipa: SIPA })).resolves.toBe(false);
  });
});
