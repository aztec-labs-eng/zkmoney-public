import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpRequestError, RpcRequestError, createPublicClient } from 'viem';

import { redactedHttp } from './redacted_http.js';

const KEY = 'FAKEKEY123';

/** The error and each error in its `cause` chain. */
function causeChain(err: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = err; current instanceof Error; current = current.cause) {
    chain.push(current);
  }
  return chain;
}

/** Every string that the error chain holds, including `message`, `stack`, and `metaMessages` entries. */
function allText(err: unknown): string[] {
  return causeChain(err).flatMap(error => [
    String(error),
    error.stack ?? '',
    ...Object.getOwnPropertyNames(error).flatMap(key => {
      const value = (error as unknown as Record<string, unknown>)[key];
      return typeof value === 'string' ? [value] : Array.isArray(value) ? value.map(String) : [];
    }),
  ]);
}

describe('redactedHttp', () => {
  let server: http.Server;
  let origin: string;
  let answer: (id: number, res: http.ServerResponse) => void;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk as Buffer));
      req.on('end', () => answer(JSON.parse(Buffer.concat(chunks).toString()).id, res));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const failedCall = (url: string): Promise<unknown> =>
    createPublicClient({ transport: redactedHttp(url, { retryCount: 0 }) })
      .getChainId()
      .then(
        () => undefined,
        (err: unknown) => err,
      );

  it.each([429, 500])('keeps the key out of an HTTP %i error and keeps the status', async status => {
    answer = (_id, res) => {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end('provider error');
    };

    const err = await failedCall(`${origin}/v2/${KEY}`);

    expect(err).toBeInstanceOf(Error);
    for (const text of allText(err)) {
      expect(text).not.toContain(KEY);
    }
    const httpError = causeChain(err).find(error => error instanceof HttpRequestError) as HttpRequestError;
    expect(httpError).toBeDefined();
    expect(httpError.status).toBe(status);
    expect(httpError.url).toBe(`${origin}/<redacted>`);
    expect(httpError.message).toContain(`URL: ${origin}/<redacted>`);
  });

  it('keeps the key out of a JSON-RPC error and keeps the error code', async () => {
    answer = (id, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'the method does not exist' } }));
    };

    const err = await failedCall(`${origin}/v2/${KEY}?key=${KEY}`);

    for (const text of allText(err)) {
      expect(text).not.toContain(KEY);
    }
    const rpcError = causeChain(err).find(error => error instanceof RpcRequestError) as RpcRequestError;
    expect(rpcError.code).toBe(-32601);
  });

  it('passes per-request options, such as retryCount, to the inner transport', async () => {
    let calls = 0;
    answer = (_id, res) => {
      calls += 1;
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('provider error');
    };
    const client = createPublicClient({
      transport: redactedHttp(`${origin}/v2/${KEY}`, { retryCount: 3, retryDelay: 1 }),
    });

    await expect(client.request({ method: 'eth_chainId' }, { retryCount: 0 })).rejects.toBeInstanceOf(Error);

    expect(calls).toBe(1);
  });
});
