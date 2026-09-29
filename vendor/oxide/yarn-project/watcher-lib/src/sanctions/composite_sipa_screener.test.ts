import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { CompositeSipaScreener } from './composite_sipa_screener.js';
import type { SipaScreener } from './sipa_screener.js';

const TARGET = { sipa: EthAddress.random() };

describe('CompositeSipaScreener', () => {
  it('stops at the first match, leaving the later (more expensive) screeners unrun', async () => {
    const run: string[] = [];
    const screener = (name: string, sanctioned: boolean): SipaScreener => ({
      isSanctioned: () => {
        run.push(name);
        return Promise.resolve(sanctioned);
      },
    });

    const composite = new CompositeSipaScreener([screener('cheap', true), screener('expensive', false)]);

    await expect(composite.isSanctioned(TARGET)).resolves.toBe(true);
    expect(run).toEqual(['cheap']);
  });

  it('passes only when every screener passes', async () => {
    const clean: SipaScreener = { isSanctioned: () => Promise.resolve(false) };
    const listed: SipaScreener = { isSanctioned: () => Promise.resolve(true) };

    await expect(new CompositeSipaScreener([clean, clean]).isSanctioned(TARGET)).resolves.toBe(false);
    await expect(new CompositeSipaScreener([clean, listed]).isSanctioned(TARGET)).resolves.toBe(true);
  });

  it('refuses an empty screener list, which would pass everything', () => {
    expect(() => new CompositeSipaScreener([])).toThrow('at least one screener');
  });
});
