import type { EthAddress } from '@aztec/foundation/eth-address';
import { type Logger, createLogger } from '@aztec/foundation/log';

import { addressKey } from '../address_key.js';
import { type SdnList, parseSdnList } from './parse_sdn_list.js';
import type { SanctionsList } from './sanctions_list.js';

export const OFAC_SDN_LIST_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';
const SDN_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SDN_FETCH_TIMEOUT_MS = 60_000;

/**
 * The OFAC SDN list, downloaded and held in memory.
 *
 * Warning: Exits the process if SDN list cannot be loaded/refreshed.
 *
 * An on-chain sanctions oracle (Chainalysis publishes a free one) would remove this download and refresh
 * lifecycle for one `eth_call` per address. We read the SDN list directly because that oracle updates far more
 * slowly than the SDN list itself, and a screen is only as good as the age of the data behind it.
 */
export class OfacSdnList implements SanctionsList {
  private list: SdnList;
  private refreshedAt: Date;
  private timer?: NodeJS.Timeout;

  private constructor(
    private readonly url: string,
    private readonly log: Logger,
    list: SdnList,
  ) {
    this.list = list;
    this.refreshedAt = new Date();
  }

  static async start(url = OFAC_SDN_LIST_URL, log = createLogger('watcher-lib:ofac-sdn-list')): Promise<OfacSdnList> {
    try {
      const sdn = new OfacSdnList(url, log, await fetchSdnList(url));
      sdn.logLoaded();
      sdn.timer = setInterval(() => void sdn.refresh(), SDN_REFRESH_INTERVAL_MS).unref();
      return sdn;
    } catch (err) {
      log.error('OFAC SDN list initial load failed; exiting', { url, err });
      process.exit(1);
      // Reachable in tests where process.exit is mocked
      throw err;
    }
  }

  isListed(address: EthAddress): boolean {
    return this.list.addresses.has(addressKey(address));
  }

  get lastRefreshedAt(): Date {
    return this.refreshedAt;
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      this.list = await fetchSdnList(this.url);
      this.refreshedAt = new Date();
      this.logLoaded();
    } catch (err) {
      this.log.error('OFAC SDN list refresh failed; exiting', { url: this.url, err });
      this.stop();
      process.exit(1);
    }
  }

  private logLoaded(): void {
    this.log.info('OFAC SDN list loaded', {
      url: this.url,
      addresses: this.list.addresses.size,
    });
  }
}

async function fetchSdnList(url: string): Promise<SdnList> {
  const response = await fetch(url, { signal: AbortSignal.timeout(SDN_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`OFAC SDN list download returned ${response.status}`);
  }
  return parseSdnList(await response.text());
}
