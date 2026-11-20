import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';
import type { IncomingMessage } from 'node:http';
import { type Hex, type PublicClient, encodeFunctionData, parseAbi } from 'viem';

import type { ProxyKind, ResolverConfig, ResolverMode } from './config.js';
import {
  type GatewayDeps,
  GatewayError,
  ResolveStageError,
  type RunningGateway,
  UndepositablePortalError,
  UnexpectedSenderError,
  UnknownNameError,
  classifyResolveError,
  computeResolveResponse,
  decodeNameHash,
  parseRequest,
  pruneNoncesOncePerDay,
  redactInfuraKeys,
  startGateway,
} from './gateway.js';
import type { RateLimiter } from './rate_limiter.js';
import type { ResolverStore } from './resolver_store.js';

const SIPA_RESOLVER = '0x00000000000000000000000000000000000000aa';
const OLD_SIPA_RESOLVER = '0x00000000000000000000000000000000000000ab';
const REGISTRY_ADDRESS = '0x00000000000000000000000000000000000000cc';
const NAME_HASH = '0x00000000000000000000000000000000000000000000000000000000deadbeef' as Hex;
const RESOLVE_RESPONSE = '0x1234' as Hex;

/** A CCIP `resolve(name, data)` calldata blob; `data` defaults to the well-formed `addr(NAME_HASH)` call. */
function resolveCallData(
  data: Hex = encodeFunctionData({
    abi: parseAbi(['function addr(bytes32 node) view returns (address)']),
    functionName: 'addr',
    args: [NAME_HASH],
  }),
): Hex {
  return encodeFunctionData({
    abi: parseAbi(['function resolve(bytes name, bytes data) view returns (bytes)']),
    functionName: 'resolve',
    args: ['0x6f78696465' as Hex, data],
  });
}

const RESOLVE_SELECTOR = '0x9061b923';

function abiWord(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

const MALFORMED_DATA: Record<string, string> = {
  'an unknown selector': '0xdeadbeef',
  'empty calldata': '0x',
  'a word that is not hex': 'HEAD',
  'an escaped character': '%7Bd',
  'a truncated selector': '0x9061b9',
  'a selector with no arguments': RESOLVE_SELECTOR,
  'an out-of-range offset': `${RESOLVE_SELECTOR}${'f'.repeat(64)}${abiWord(0x40n)}`,
  'an out-of-bounds offset': `${RESOLVE_SELECTOR}${abiWord(0x1000n)}${abiWord(0x40n)}`,
  'a wrapped call that is not addr(bytes32)': resolveCallData('0xdeadbeef'),
};

function fakeGet(url: string): IncomingMessage {
  return { method: 'GET', url } as IncomingMessage;
}

function fakePost(body: string): IncomingMessage {
  const req = {
    method: 'POST',
    url: '/',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8');
    },
  };
  return req as unknown as IncomingMessage;
}

describe('parseRequest', () => {
  it('parses the EIP-3668 GET form and strips the .json suffix', async () => {
    const parsed = await parseRequest(fakeGet(`/${SIPA_RESOLVER}/0xdata.json`));
    expect(parsed).toEqual({ sender: SIPA_RESOLVER, data: '0xdata' });
  });

  it('rejects GETs without exactly {sender}/{data}', async () => {
    await expect(parseRequest(fakeGet('/only-one'))).rejects.toMatchObject({ status: 400 });
    await expect(parseRequest(fakeGet('/a/b/c'))).rejects.toMatchObject({ status: 400 });
  });

  it('parses the POST form and rejects malformed bodies', async () => {
    const parsed = await parseRequest(fakePost(JSON.stringify({ sender: SIPA_RESOLVER, data: '0xdata' })));
    expect(parsed).toEqual({ sender: SIPA_RESOLVER, data: '0xdata' });
    await expect(parseRequest(fakePost(JSON.stringify({ sender: SIPA_RESOLVER })))).rejects.toMatchObject({
      status: 400,
    });
    await expect(parseRequest(fakePost('{"sender":'))).rejects.toMatchObject({ status: 400 });
    await expect(parseRequest(fakePost('null'))).rejects.toMatchObject({ status: 400 });
  });

  it('rejects other methods', async () => {
    await expect(parseRequest({ method: 'PUT', url: '/' } as IncomingMessage)).rejects.toMatchObject({ status: 405 });
  });
});

describe('decodeNameHash', () => {
  it('recovers the nameHash from the wrapped addr(node) call', () => {
    expect(decodeNameHash(resolveCallData())).toBe(NAME_HASH);
  });

  it('throws on junk calldata', () => {
    expect(() => decodeNameHash('0xdeadbeef')).toThrow();
  });
});

describe('redactInfuraKeys', () => {
  it('redacts every URL-shaped token mentioning infura and leaves other text alone', () => {
    const msg =
      'first https://mainnet.infura.io/v3/0123456789abcdefABCDEF0123456789 then ' +
      'wss://sepolia.INFURA.io/ws/v3/whatever?secret=x done';
    expect(redactInfuraKeys(msg)).toBe('first <infura-url> then <infura-url> done');
    expect(redactInfuraKeys('name not registered: 0xdeadbeef')).toBe('name not registered: 0xdeadbeef');
  });

  it('leaves prose that merely mentions infura untouched', () => {
    expect(redactInfuraKeys('Infura returned 429, retry later')).toBe('Infura returned 429, retry later');
    expect(redactInfuraKeys('rate limited by infura.')).toBe('rate limited by infura.');
  });
});

type RoundTrip = {
  gateway: RunningGateway;
  limiterCalls: { ip: string; nameHash: string }[];
  /** The outcome of each resolve, in the order the gateway records it. */
  outcomes: string[];
  errorLogs: string[];
  url: string;
};

async function startStubbedGateway(opts: {
  mode?: ResolverMode;
  proxyKind?: ProxyKind;
  allow?: (ip: string, nameHash: string) => boolean | Promise<boolean>;
  resolve?: GatewayDeps['resolve'];
}): Promise<RoundTrip> {
  const limiterCalls: RoundTrip['limiterCalls'] = [];
  const rateLimiter: RateLimiter = {
    allow: (ip, nameHash) => {
      limiterCalls.push({ ip, nameHash });
      return opts.allow ? opts.allow(ip, nameHash) : true;
    },
  };
  const store = {} as ResolverStore;
  const config = {
    mode: opts.mode ?? 'gateway',
    proxyKind: opts.proxyKind ?? ((opts.mode ?? 'gateway') === 'gateway' ? 'apigw' : 'none'),
    nameRegistryAddress: EthAddress.fromString(REGISTRY_ADDRESS),
    resolverAddress: EthAddress.fromString(SIPA_RESOLVER),
    httpHost: '127.0.0.1',
    httpPort: 0,
  } as ResolverConfig;

  const publicClient = {
    readContract: ({ functionName }: { functionName: string }) =>
      Promise.reject(new Error(`unexpected readContract: ${functionName}`)),
  } as unknown as PublicClient;

  const outcomes: string[] = [];
  const errorLogs: string[] = [];
  const gateway = await startGateway(config, store, rateLimiter, publicClient, {
    resolve: opts.resolve ?? (() => Promise.resolve(RESOLVE_RESPONSE)),
    telemetry: {
      resolveCompleted: (outcome: string) => outcomes.push(outcome),
      flushBounded: () => Promise.resolve(),
    } as never,
    log: {
      info: () => {},
      error: (message: string) => errorLogs.push(message),
    } as never,
  });
  return { gateway, limiterCalls, outcomes, errorLogs, url: `http://127.0.0.1:${gateway.port}` };
}

describe('gateway HTTP round-trip', () => {
  it('serves /health without touching the limiter or store', async () => {
    const t = await startStubbedGateway({});
    try {
      const res = await fetch(`${t.url}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
      expect(t.limiterCalls).toEqual([]);
    } finally {
      await t.gateway.close();
    }
  });

  it('answers the GET and POST forms with the resolve response', async () => {
    const t = await startStubbedGateway({});
    try {
      const get = await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`);
      expect(get.status).toBe(200);
      expect(await get.json()).toEqual({ data: RESOLVE_RESPONSE });

      const post = await fetch(t.url, {
        method: 'POST',
        body: JSON.stringify({ sender: SIPA_RESOLVER, data: resolveCallData() }),
      });
      expect(post.status).toBe(200);
      expect(await post.json()).toEqual({ data: RESOLVE_RESPONSE });
      expect(t.limiterCalls.map(c => c.nameHash)).toEqual([NAME_HASH, NAME_HASH]);
    } finally {
      await t.gateway.close();
    }
  });

  // The gateway answers for the module it is configured with, not for whichever module the NameRegistry names: a
  // deployment env that preserves its registry keeps that pointer on an earlier generation's module.
  it('rejects a module that is not the one this gateway answers for', async () => {
    const t = await startStubbedGateway({});
    try {
      const res = await fetch(`${t.url}/${OLD_SIPA_RESOLVER}/${resolveCallData()}.json`);
      expect(res.status).toBe(400);
    } finally {
      await t.gateway.close();
    }
  });

  it('rejects an unexpected sender with 400 and other methods with 405', async () => {
    const t = await startStubbedGateway({});
    try {
      const badSender = '0x00000000000000000000000000000000000000bb';
      const res = await fetch(`${t.url}/${badSender}/${resolveCallData()}.json`);
      expect(res.status).toBe(400);

      const put = await fetch(t.url, { method: 'PUT' });
      expect(put.status).toBe(405);

      // The metric, not just the status: the alarm counts outcomes, so a request path that fell back to a generic
      // 4xx would still answer 400 here while going silent in CloudWatch.
      expect(t.outcomes).toContain('unexpected_sender');
    } finally {
      await t.gateway.close();
    }
  });

  // A rejected sender is the one 4xx that means the deployment is broken rather than the caller: the sender comes
  // from the record ENS names, so a mismatch fails every ENS-rooted resolve. It must not share an outcome with
  // malformed input, which the `oxide-resolver-gateway-failed-requests` alarm excludes as caller error.
  it('records a rejected sender as its own outcome, apart from malformed input', () => {
    expect(classifyResolveError(new UnexpectedSenderError('0xbb', '0xaa'))).toBe('unexpected_sender');
    expect(classifyResolveError(new GatewayError(400, 'bad request'))).toBe('invalid_request');
    expect(classifyResolveError(new UndepositablePortalError('frozen'))).toBe('undepositable_portal');
  });

  it('redacts Infura URLs from error bodies while keeping the message reportable', async () => {
    // A viem transport error carries the full RPC URL; the key must come out, the rest must survive so users can
    // report what actually failed.
    const key = 'aaaabbbbccccddddeeeeffff00001111';
    const t = await startStubbedGateway({
      resolve: () =>
        Promise.reject(new Error(`HTTP request failed.\nStatus: 429\nURL: https://mainnet.infura.io/v3/${key}`)),
    });
    try {
      const res = await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`);
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toContain(key);
      expect((JSON.parse(body) as { message: string }).message).toContain('Status: 429\nURL: <infura-url>');
    } finally {
      await t.gateway.close();
    }
  });

  it('answers 400 to a request that it cannot decode, and logs no error', async () => {
    const t = await startStubbedGateway({});
    try {
      const statuses: Record<string, number> = {};
      for (const [shape, data] of Object.entries(MALFORMED_DATA)) {
        statuses[shape] = (await fetch(`${t.url}/${SIPA_RESOLVER}/${data}.json`)).status;
      }
      statuses['a POST body that is not JSON'] = (await fetch(t.url, { method: 'POST', body: '{"sender":' })).status;

      expect(Object.entries(statuses).filter(([, status]) => status !== 400)).toEqual([]);
      expect(new Set(t.outcomes)).toEqual(new Set(['invalid_request']));
      expect(t.errorLogs).toEqual([]);
      expect(t.limiterCalls).toEqual([]);
    } finally {
      await t.gateway.close();
    }
  });

  it('answers 404 to a name that has no record, and logs no error', async () => {
    const t = await startStubbedGateway({
      resolve: () => Promise.reject(new UnknownNameError(`name not registered: ${NAME_HASH}`)),
    });
    try {
      const res = await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: `name not registered: ${NAME_HASH}` });
      expect(t.outcomes).toEqual(['unknown_name']);
      expect(t.errorLogs).toEqual([]);
    } finally {
      await t.gateway.close();
    }
  });

  it('answers 500 to a store, proof, or RPC failure, and logs it as an error', async () => {
    const failures = [
      new ResolveStageError('store', new Error('connection reset')),
      new ResolveStageError('proof', new Error('prover exited')),
      new Error('HTTP request failed.'),
    ];
    let next = 0;
    const t = await startStubbedGateway({ resolve: () => Promise.reject(failures[next++]) });
    try {
      const statuses: number[] = [];
      for (const _ of failures) {
        statuses.push((await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`)).status);
      }
      expect(statuses).toEqual([500, 500, 500]);
      expect(t.outcomes).toEqual(['store_error', 'proof_error', 'internal_error']);
      expect(t.errorLogs).toHaveLength(3);
    } finally {
      await t.gateway.close();
    }
  });

  it('returns 429 when the limit is exceeded', async () => {
    const t = await startStubbedGateway({ allow: () => false });
    try {
      const res = await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`);
      expect(res.status).toBe(429);
    } finally {
      await t.gateway.close();
    }
  });

  it('fails closed with 503 when the limiter is unavailable', async () => {
    const t = await startStubbedGateway({
      allow: () => Promise.reject(new Error('connection refused')),
    });
    try {
      const res = await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ message: 'rate limiter unavailable' });
    } finally {
      await t.gateway.close();
    }
  });

  it('rate-limits by the proxy-appended (last) X-Forwarded-For entry when a proxy is trusted', async () => {
    const t = await startStubbedGateway({ mode: 'gateway' });
    try {
      // A spoofer controls every entry but the last one, which the trusted proxy hop appended. Both requests must
      // therefore land in the same bucket rather than minting a fresh allowance each time.
      await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`, {
        headers: { 'x-forwarded-for': '6.6.6.6, 9.9.9.9' },
      });
      await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`, {
        headers: { 'x-forwarded-for': '7.7.7.7, 9.9.9.9' },
      });
      expect(t.limiterCalls.map(c => c.ip)).toEqual(['9.9.9.9', '9.9.9.9']);
    } finally {
      await t.gateway.close();
    }
  });

  it('tolerates odd X-Forwarded-For shapes without falling back to a spoofable entry', async () => {
    const t = await startStubbedGateway({ mode: 'gateway' });
    try {
      // Whitespace and a trailing empty entry must not shift which entry is authoritative...
      await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`, {
        headers: { 'x-forwarded-for': '6.6.6.6 ,  9.9.9.9 , ' },
      });
      // ...and an empty header falls back to the socket address, never to nothing.
      await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`, { headers: { 'x-forwarded-for': '' } });
      expect(t.limiterCalls.map(c => c.ip)).toEqual(['9.9.9.9', '127.0.0.1']);
    } finally {
      await t.gateway.close();
    }
  });

  it('ignores X-Forwarded-For entirely with no trusted proxy', async () => {
    const t = await startStubbedGateway({ mode: 'local', proxyKind: 'none' });
    try {
      await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`, {
        headers: { 'x-forwarded-for': '6.6.6.6' },
      });
      expect(t.limiterCalls).toHaveLength(1);
      expect(t.limiterCalls[0].ip).toBe('127.0.0.1');
    } finally {
      await t.gateway.close();
    }
  });

  it('rate-limits by CloudFront-Viewer-Address when the ingress is cloudfront', async () => {
    const t = await startStubbedGateway({ mode: 'gateway', proxyKind: 'cloudfront' });
    try {
      // CloudFront sets this header itself and strips any client-supplied version, so the IP is authoritative even
      // when XFF (which now carries a two-hop chain: CloudFront then API Gateway) points at the CloudFront edge.
      await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`, {
        headers: {
          'cloudfront-viewer-address': '203.0.113.7:52345',
          'x-forwarded-for': '203.0.113.7, 130.176.0.10',
        },
      });
      // IPv6 form: brackets and port must both come off.
      await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`, {
        headers: { 'cloudfront-viewer-address': '[2001:db8::1]:65535' },
      });
      // Missing header falls back to the socket peer, never to XFF.
      await fetch(`${t.url}/${SIPA_RESOLVER}/${resolveCallData()}.json`, {
        headers: { 'x-forwarded-for': '6.6.6.6' },
      });
      expect(t.limiterCalls.map(c => c.ip)).toEqual(['203.0.113.7', '2001:db8::1', '127.0.0.1']);
    } finally {
      await t.gateway.close();
    }
  });
});

describe('computeResolveResponse', () => {
  it('refuses a user record for another rollup version before it spends a nonce', async () => {
    const point = { x: 1n, y: 2n };
    const table = '0x00000000000000000000000000000000000000d4';
    const reads: Record<string, unknown> = {
      ownerOf: '0x00000000000000000000000000000000000000d1',
      hasUserRecord: true,
      getUserRecord: { l2Address: `0x${'11'.repeat(32)}`, rollupVersion: 5n, publicKey: point },
      resolverOperators: [point, `0x${'22'.repeat(32)}`, 'https://gateway', table],
      ROLLUP_VERSION: 6n,
    };
    let nonces = 0;
    const deps = {
      config: {
        nameRegistryAddress: EthAddress.fromString(REGISTRY_ADDRESS),
        resolverPrivateKey: {},
        resolverPublicKey: {},
        depositTokens: [],
      },
      store: { nextNonce: () => Promise.resolve(nonces++) },
      publicClient: {
        readContract: ({ functionName }: { functionName: string }) => Promise.resolve(reads[functionName] ?? table),
        getBlock: () => Promise.resolve({ timestamp: 0n }),
        getChainId: () => Promise.resolve(31337),
      },
    } as unknown as GatewayDeps;

    await expect(computeResolveResponse(deps, NAME_HASH)).rejects.toThrow(/rollup version 5, but .* serves 6/);
    expect(nonces).toBe(0);
  });
});

describe('pruneNoncesOncePerDay', () => {
  it('prunes once for each new day and ignores an earlier day', async () => {
    const days: number[] = [];
    const deps = {
      store: { pruneNonces: (day: number) => (days.push(day), Promise.resolve(0)) },
      log: { info: () => {}, warn: () => {} },
    } as unknown as GatewayDeps;

    for (const day of [10, 10, 11, 10, 11, 12]) {
      pruneNoncesOncePerDay(deps, day);
    }
    await Promise.resolve();
    expect(days).toEqual([10, 11, 12]);
  });

  it('logs a failed prune instead of failing the resolve', async () => {
    const warnings: string[] = [];
    const deps = {
      store: { pruneNonces: () => Promise.reject(new Error('store down')) },
      log: { info: () => {}, warn: (message: string) => warnings.push(message) },
    } as unknown as GatewayDeps;

    pruneNoncesOncePerDay(deps, 1);
    await new Promise(resolve => setImmediate(resolve));
    expect(warnings).toEqual(['failed to prune nonce counters: store down']);
  });
});
