import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';

import { parseSdnList } from './parse_sdn_list.js';

const FIXTURE = readFileSync(new URL('./fixtures/sdn.xml', import.meta.url), 'utf8');
const LISTED = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96';

describe('parseSdnList', () => {
  it('extracts every EVM digital currency address, lowercased and deduplicated', () => {
    const { addresses } = parseSdnList(FIXTURE);
    expect([...addresses].sort()).toEqual([
      '0x098b716b8aaf21512996dc57eb0615e2383e2f96',
      '0xa0e1c89ef1a489c9c7de96311ed5ce5d32c20e4b',
    ]);
  });

  it('pairs each identifier type with its value structurally', () => {
    const withInterveningElement = FIXTURE.replace(
      '<idType>Digital Currency Address - ETH</idType>',
      '<idType>Digital Currency Address - ETH</idType><issuer>Ethereum</issuer>',
    );
    expect(parseSdnList(withInterveningElement).addresses).toContain(LISTED.toLowerCase());
  });

  it('rejects a truncated download rather than accepting a partial list', () => {
    const firstIdEnd = FIXTURE.indexOf('</id>', FIXTURE.indexOf(LISTED)) + '</id>'.length;
    expect(() => parseSdnList(FIXTURE.slice(0, firstIdEnd))).toThrow(/well-formed XML/);
  });

  it('rejects a body without any EVM address', () => {
    expect(() => parseSdnList(FIXTURE.replace(/Digital Currency Address - (ETH|USDT)/g, 'Passport'))).toThrow(
      /no EVM addresses/,
    );
  });
});
