import { EthAddress } from '@aztec/foundation/eth-address';
import { createLogger } from '@aztec/foundation/log';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

import { OfacSdnList } from './ofac_sdn_list.js';

const URL_UNDER_TEST = 'http://sdn.test/SDN.XML';
const FIXTURE = readFileSync(new URL('./fixtures/sdn.xml', import.meta.url), 'utf8');
const LISTED = EthAddress.fromString('0x098B716B8Aaf21512996dC57EB0615e2383E2f96');
const UNLISTED = EthAddress.fromString('0x1111111111111111111111111111111111111111');
const NEWLY_LISTED = EthAddress.fromString('0x2222222222222222222222222222222222222222');
const DAY_MS = 24 * 60 * 60 * 1000;

const withNewlyListed = FIXTURE.replace(new RegExp(LISTED.toString(), 'gi'), NEWLY_LISTED.toString());

function xmlResponse(body: string, status = 200): Response {
  return { ok: status < 400, status, text: () => Promise.resolve(body) } as unknown as Response;
}

describe('OfacSdnList', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let sdn: OfacSdnList | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    sdn?.stop();
    sdn = undefined;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('screens against the downloaded list', async () => {
    fetchSpy.mockResolvedValue(xmlResponse(FIXTURE));
    sdn = await OfacSdnList.start(URL_UNDER_TEST);

    expect(fetchSpy.mock.calls[0][0]).toBe(URL_UNDER_TEST);
    expect(sdn.isListed(LISTED)).toBe(true);
    expect(sdn.isListed(UNLISTED)).toBe(false);
    expect(sdn.lastRefreshedAt).toEqual(new Date());
  });

  it('fails to start on a non-ok response', async () => {
    fetchSpy.mockResolvedValue(xmlResponse('', 503));
    await expect(OfacSdnList.start(URL_UNDER_TEST)).rejects.toThrow(/503/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('fails to start when the download fails', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    await expect(OfacSdnList.start(URL_UNDER_TEST)).rejects.toThrow(/network down/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('fails to start on a garbled list', async () => {
    fetchSpy.mockResolvedValue(xmlResponse('<html>maintenance</html>'));
    await expect(OfacSdnList.start(URL_UNDER_TEST)).rejects.toThrow(/no EVM addresses/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('replaces the list on the daily refresh', async () => {
    fetchSpy.mockResolvedValueOnce(xmlResponse(FIXTURE)).mockResolvedValueOnce(xmlResponse(withNewlyListed));
    sdn = await OfacSdnList.start(URL_UNDER_TEST);
    const startedAt = sdn.lastRefreshedAt;

    await jest.advanceTimersByTimeAsync(DAY_MS);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sdn.isListed(NEWLY_LISTED)).toBe(true);
    expect(sdn.isListed(LISTED)).toBe(false);
    expect(sdn.lastRefreshedAt.getTime()).toBe(startedAt.getTime() + DAY_MS);
  });

  it('exits when a scheduled refresh fails', async () => {
    const log = createLogger('test');
    const error = jest.spyOn(log, 'error').mockImplementation(() => {});
    fetchSpy.mockResolvedValueOnce(xmlResponse(FIXTURE)).mockRejectedValueOnce(new Error('network down'));
    sdn = await OfacSdnList.start(URL_UNDER_TEST, log);

    await jest.advanceTimersByTimeAsync(DAY_MS);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('OFAC SDN list refresh failed; exiting', {
      url: URL_UNDER_TEST,
      err: new Error('network down'),
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('stops refreshing once stopped', async () => {
    fetchSpy.mockResolvedValue(xmlResponse(FIXTURE));
    sdn = await OfacSdnList.start(URL_UNDER_TEST);
    sdn.stop();

    await jest.advanceTimersByTimeAsync(2 * DAY_MS);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
