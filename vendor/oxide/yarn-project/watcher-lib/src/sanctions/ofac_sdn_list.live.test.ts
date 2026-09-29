import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { OFAC_SDN_LIST_URL, OfacSdnList } from './ofac_sdn_list.js';
import { parseSdnList } from './parse_sdn_list.js';

const LIVE = process.env.OXIDE_TEST_LIVE_SDN;
const LIVE_TIMEOUT_MS = 180_000;
const LAZARUS_GROUP = EthAddress.fromString('0x098B716B8Aaf21512996dC57EB0615e2383E2f96');

(LIVE ? describe : describe.skip)('OFAC SDN list (live download)', () => {
  it(
    'parses the published list into EVM addresses',
    async () => {
      const response = await fetch(OFAC_SDN_LIST_URL);
      expect(response.ok).toBe(true);

      const { addresses } = parseSdnList(await response.text());

      expect(addresses.size).toBeGreaterThanOrEqual(100);
      for (const address of addresses) {
        expect(address).toMatch(/^0x[0-9a-f]{40}$/);
      }
      expect(addresses.has(LAZARUS_GROUP.toString())).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'screens against the published list',
    async () => {
      const sdn = await OfacSdnList.start();
      try {
        expect(sdn.isListed(LAZARUS_GROUP)).toBe(true);
        expect(sdn.isListed(EthAddress.random())).toBe(false);
      } finally {
        sdn.stop();
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
