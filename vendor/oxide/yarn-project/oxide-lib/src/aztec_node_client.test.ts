import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createNodeClient } from './aztec_node_client.js';

const NODE_URL = 'https://node.test';
const PROVEN_CHECKPOINT = 42;
const API_KEY = 'secret-key-value';

function response(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status < 400,
    status,
    statusText,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// The client rejects an answer that does not echo its own request ids.
function answerWith(result: unknown): (url: unknown, init: unknown) => Promise<Response> {
  return (_url, init) => {
    const batch = JSON.parse((init as RequestInit).body as string) as Array<{ id: number }>;
    return Promise.resolve(response(batch.map(call => ({ jsonrpc: '2.0', id: call.id, result }))));
  };
}
const notJson = (status: number, statusText: string): Response =>
  ({
    ok: false,
    status,
    statusText,
    headers: { get: () => null },
    text: () => Promise.resolve('<html>Too Many Requests</html>'),
  }) as unknown as Response;
const rateLimited = () => response({ message: 'API rate limit exceeded' }, 429, 'Too Many Requests');
const forbidden = () => response({ message: 'Forbidden' }, 403, 'Forbidden');

function headersSentOn(spy: jest.SpiedFunction<typeof fetch>, call = 0): Record<string, string> {
  return (spy.mock.calls[call][1] as RequestInit).headers as Record<string, string>;
}

async function callNode(endpoint: { url: string; apiKey?: string }): Promise<unknown> {
  return await createNodeClient(endpoint)
    .getCheckpointNumber('proven')
    .catch(() => undefined);
}

describe('createNodeClient', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends no api key header when no key is configured', async () => {
    fetchSpy.mockImplementation(answerWith(PROVEN_CHECKPOINT));

    await callNode({ url: NODE_URL });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = headersSentOn(fetchSpy);
    expect(Object.keys(headers).map(name => name.toLowerCase())).not.toContain('x-api-key');
    expect(headers['content-type']).toBe('application/json');
  });

  it('sends the api key as an x-api-key header when a key is configured', async () => {
    fetchSpy.mockImplementation(answerWith(PROVEN_CHECKPOINT));

    await callNode({ url: NODE_URL, apiKey: API_KEY });

    const headers = headersSentOn(fetchSpy);
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['content-type']).toBe('application/json');
  });

  it('treats an empty key as no key', async () => {
    fetchSpy.mockImplementation(answerWith(PROVEN_CHECKPOINT));

    await callNode({ url: NODE_URL, apiKey: '' });

    const headers = headersSentOn(fetchSpy);
    expect(Object.keys(headers).map(name => name.toLowerCase())).not.toContain('x-api-key');
  });

  it('retries a rate-limited request and then returns the node answer', async () => {
    fetchSpy
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockImplementation(answerWith(PROVEN_CHECKPOINT));

    const checkpoint = await callNode({ url: NODE_URL, apiKey: API_KEY });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(headersSentOn(fetchSpy, 2)['x-api-key']).toBe(API_KEY);
    expect(Number(checkpoint)).toBe(PROVEN_CHECKPOINT);
  });

  it('refuses to send a key to a plain http node', () => {
    expect(() => createNodeClient({ url: 'http://node.test', apiKey: API_KEY })).toThrow(/use https/);
  });

  it('allows a key on a loopback node, for a local run', () => {
    expect(() => createNodeClient({ url: 'http://127.0.0.1:8080', apiKey: API_KEY })).not.toThrow();
  });

  it('allows a plain http node when no key is configured', () => {
    expect(() => createNodeClient({ url: 'http://node.test' })).not.toThrow();
  });

  it('bounds the requests it makes for a rate limit whose body is not JSON', async () => {
    fetchSpy.mockResolvedValue(notJson(429, 'Too Many Requests'));

    await callNode({ url: NODE_URL, apiKey: API_KEY });

    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(5);
  }, 30_000);

  it('refuses to follow a redirect, so the key cannot reach another origin', async () => {
    const seen: RequestRedirect[] = [];
    fetchSpy.mockImplementation((_url, init) => {
      seen.push((init as RequestInit).redirect!);
      return Promise.reject(new TypeError('unexpected redirect'));
    });

    await callNode({ url: NODE_URL, apiKey: API_KEY });

    expect(seen[0]).toBe('error');
  }, 30_000);

  it('treats a whitespace-only key as no key', async () => {
    fetchSpy.mockImplementation(answerWith(PROVEN_CHECKPOINT));

    await callNode({ url: NODE_URL, apiKey: '   ' });

    expect(Object.keys(headersSentOn(fetchSpy)).map(name => name.toLowerCase())).not.toContain('x-api-key');
  });

  it('does not retry a rejected key', async () => {
    fetchSpy.mockResolvedValue(forbidden());

    await callNode({ url: NODE_URL, apiKey: API_KEY });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('gives up after a bounded number of rate-limited attempts', async () => {
    fetchSpy.mockResolvedValue(rateLimited());

    await callNode({ url: NODE_URL, apiKey: API_KEY });

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
