import type { ScreenedSipa, SipaScreener } from './sipa_screener.js';

/**
 * Runs its screeners in order and stops at the first match, so cheap checks belong first: a local list lookup
 * before a network call, a network call before a multi-request chain scan.
 */
export class CompositeSipaScreener implements SipaScreener {
  constructor(private readonly screeners: SipaScreener[]) {
    if (screeners.length === 0) {
      throw new Error('CompositeSipaScreener needs at least one screener; an empty composite would pass everything');
    }
  }

  async isSanctioned(target: ScreenedSipa): Promise<boolean> {
    for (const screener of this.screeners) {
      if (await screener.isSanctioned(target)) {
        return true;
      }
    }
    return false;
  }
}
