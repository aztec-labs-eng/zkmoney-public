import type { SanctionsList } from './sanctions_list.js';
import type { FindFunders, ScreenedSipa, SipaScreener } from './sipa_screener.js';

/** Every address that funded a SIPA, checked against the list. The lookup decides how far back "funded" reaches. */
export class SipaFunderScreener implements SipaScreener {
  constructor(
    private readonly list: SanctionsList,
    private readonly findFunders: FindFunders,
  ) {}

  async isSanctioned({ sipa }: ScreenedSipa): Promise<boolean> {
    return (await this.findFunders(sipa)).some(funder => this.list.isListed(funder));
  }
}
