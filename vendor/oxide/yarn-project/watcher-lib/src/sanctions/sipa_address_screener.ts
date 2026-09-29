import type { SanctionsList } from './sanctions_list.js';
import type { ScreenedSipa, SipaScreener } from './sipa_screener.js';

/** The address a SIPA is known by before any chain read: the SIPA itself. */
export class SipaAddressScreener implements SipaScreener {
  constructor(private readonly list: SanctionsList) {}

  isSanctioned({ sipa }: ScreenedSipa): Promise<boolean> {
    return Promise.resolve(this.list.isListed(sipa));
  }
}
