import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { secp256k1 } from '@oxide/resolver-lib/libsecp256k1.js';
import { Secp256k1Point } from '@oxide/resolver-lib/secp256k1_point.js';

import { type Hex, hexToBytes, isHex } from 'viem';

import { MEMORY_RATE_LIMITER_URL } from './memory_rate_limiter.js';

/**
 * Where the gateway runs: `local` = one process on local state (dev/e2e), `gateway` = one instance of the Lambda fleet
 * on the shared SQL store and the shared rate limiter.
 */
export type ResolverMode = 'local' | 'gateway';

/**
 * Which ingress fronts this listener, and therefore where the true client IP has to come from for rate-limiter
 * bucketing:
 *   - `none`      → socket peer address; every forwarded-for header is ignored as client-controlled
 *   - `apigw`     → API Gateway is the sole hop; last `X-Forwarded-For` entry is what API Gateway appended
 *   - `cloudfront`→ CloudFront + API Gateway; read `CloudFront-Viewer-Address`, which CloudFront sets itself and
 *                   strips any client-supplied version of, so it is unforgeable. XFF is now a two-hop chain and its
 *                   last entry is API Gateway's view of the CloudFront edge IP — useless as a client identifier.
 */
export type ProxyKind = 'none' | 'apigw' | 'cloudfront';

export type ResolverConfig = {
  mode: ResolverMode;
  /** Circuit `resolverPrivateKey` (32 bytes). The matching public key must be registered on-chain. */
  resolverPrivateKey: Uint8Array;
  resolverPublicKey: Secp256k1Point;
  /** NameRegistry — the root every record read goes through. */
  nameRegistryAddress: EthAddress;
  /** The Resolver module this gateway answers for, and the only `sender` an EIP-3668 callback may name. Configured
   *  rather than read off `NameRegistry.resolver`, because a deployment env that preserves its registry across
   *  generations keeps that pointer on the module an earlier Pool needs. */
  resolverAddress: EthAddress;
  /** SIPAFactory — SIPA create2 address prediction targets it. */
  sipaFactoryAddress: EthAddress;
  l1RpcUrl: string;
  /** ERC20s a SIPA may be funded with. The gateway refuses a name when no portal of these tokens is open. */
  depositTokens: EthAddress[];
  httpHost: string;
  httpPort: number;
  /**
   * Which ingress fronts this listener. Wrong either way breaks rate limiting — trusting a hop that is not there lets
   * clients forge their bucket; not trusting one that is buckets everyone under the proxy's address.
   */
  proxyKind: ProxyKind;
  /** Local state dir for the LMDB store. Used only when there is no dbUrl. */
  dataDir?: string;
  /** Per-(client IP, resolved name) cap: at most this many resolves an hour for one IP+name pair. */
  requestsPerHour: number;
  /** Shared SQL store URL. Required in gateway mode. Absent in local mode → LMDB at dataDir. */
  dbUrl?: string;
  dbSchema?: string;
  /** CA bundle for TLS to the SQL store (the baked RDS bundle in prod). */
  dbCaPath?: string;
  /** Shared rate-limiter store URL. Local mode may use the in-process limiter. */
  redisUrl: string;
  /** Explicit proving thread count; absent → the bb default (min(16, cores)). */
  proverThreads?: number;
  /** Native `noir-execute` binary solving the circuit witness; absent → the wasm solver bundled with noir_js. */
  noirExecuteBinaryPath?: string;
  /** The resolver operator this process runs for. Absent in dev and e2e runs. */
  operatorId?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === '' ? undefined : value;
}

function requireHex32(name: string): Hex {
  const value = requireEnv(name);
  if (!isHex(value) || hexToBytes(value).length !== 32) {
    throw new Error(`${name} must be a 32-byte hex string`);
  }
  return value;
}

function loadMode(): ResolverMode {
  const mode = optionalEnv('OXIDE_RESOLVER_MODE') ?? 'local';
  if (mode !== 'local' && mode !== 'gateway') {
    throw new Error(`OXIDE_RESOLVER_MODE must be local or gateway (got '${mode}')`);
  }
  return mode;
}

function loadProxyKind(mode: ResolverMode): ProxyKind {
  // In production, the gateway Lambda sits behind CloudFront in front of API Gateway; the deploy sets this env var
  // explicitly. If it is unset (dev image, or a bare API-GW-only deploy), fall back to `apigw` in gateway mode and
  // `none` in local mode — that matches the pre-CloudFront default without a client-controlled bucket.
  const raw = optionalEnv('OXIDE_RESOLVER_PROXY_KIND');
  if (raw === undefined) {
    return mode === 'gateway' ? 'apigw' : 'none';
  }
  if (raw !== 'none' && raw !== 'apigw' && raw !== 'cloudfront') {
    throw new Error(`OXIDE_RESOLVER_PROXY_KIND must be none, apigw or cloudfront (got '${raw}')`);
  }
  return raw;
}

export function loadConfig(): ResolverConfig {
  const mode = loadMode();

  const resolverPrivateKey = hexToBytes(requireHex32('OXIDE_RESOLVER_PRIVATE_KEY'));
  if (!secp256k1.privateKeyVerify(resolverPrivateKey)) {
    throw new Error('OXIDE_RESOLVER_PRIVATE_KEY is not a valid secp256k1 scalar');
  }
  const resolverPublicKey = Secp256k1Point.fromSec1(secp256k1.publicKeyCreate(resolverPrivateKey, false));

  // Required: with no token, every name is undepositable.
  const depositTokens = requireEnv('OXIDE_RESOLVER_DEPOSIT_TOKENS')
    .split(',')
    .map(t => t.trim())
    .filter(t => t.length > 0)
    .map(t => EthAddress.fromString(t));
  if (depositTokens.length === 0) {
    throw new Error('OXIDE_RESOLVER_DEPOSIT_TOKENS must list at least one token');
  }

  const dbUrl = optionalEnv('OXIDE_RESOLVER_DB_URL');
  if (mode === 'gateway' && !dbUrl) {
    throw new Error('OXIDE_RESOLVER_DB_URL is required in gateway mode — the fleet shares one SQL store');
  }
  const dataDir = optionalEnv('OXIDE_RESOLVER_DATA_DIR');
  if (!dbUrl && !dataDir) {
    throw new Error('no OXIDE_RESOLVER_DB_URL and no OXIDE_RESOLVER_DATA_DIR — nowhere to put the store');
  }

  const redisUrl = optionalEnv('OXIDE_RESOLVER_REDIS_URL');
  if (!redisUrl) {
    // The gateway is deployed as a fleet, so a per-instance bucket would multiply the limit by the instance count and
    // reset on every cold start. Only local mode, which runs as one process, can use the in-process limiter.
    throw new Error(`${mode} mode requires OXIDE_RESOLVER_REDIS_URL — the rate limit is fleet-wide or it is nothing`);
  }
  if (mode === 'gateway' && redisUrl === MEMORY_RATE_LIMITER_URL) {
    throw new Error(`gateway mode requires a shared OXIDE_RESOLVER_REDIS_URL, not ${MEMORY_RATE_LIMITER_URL}`);
  }

  const proverThreads = optionalEnv('OXIDE_RESOLVER_PROVER_THREADS');
  const requestsPerHour = optionalEnv('OXIDE_RESOLVER_RATE_REQUESTS_PER_HOUR') ?? '100';
  if (!/^[1-9][0-9]*$/.test(requestsPerHour)) {
    throw new Error('OXIDE_RESOLVER_RATE_REQUESTS_PER_HOUR must be a positive whole number');
  }

  return {
    mode,
    resolverPrivateKey,
    resolverPublicKey,
    nameRegistryAddress: EthAddress.fromString(requireEnv('OXIDE_RESOLVER_NAME_REGISTRY_ADDRESS')),
    resolverAddress: EthAddress.fromString(requireEnv('OXIDE_RESOLVER_ADDRESS')),
    sipaFactoryAddress: EthAddress.fromString(requireEnv('OXIDE_RESOLVER_SIPA_FACTORY_ADDRESS')),
    l1RpcUrl: requireEnv('OXIDE_RESOLVER_L1_RPC_URL'),
    depositTokens,
    httpHost: optionalEnv('OXIDE_RESOLVER_HTTP_HOST') ?? '127.0.0.1',
    httpPort: parseInt(optionalEnv('OXIDE_RESOLVER_HTTP_PORT') ?? '8081', 10),
    // Gateway instances always sit behind an ingress. A local run defaults to a direct connection, so it reads the
    // socket address rather than a header the client controls.
    proxyKind: loadProxyKind(mode),
    dataDir,
    requestsPerHour: parseInt(requestsPerHour, 10),
    dbUrl,
    dbSchema: optionalEnv('OXIDE_RESOLVER_DB_SCHEMA'),
    dbCaPath: optionalEnv('OXIDE_RESOLVER_DB_CA_PATH'),
    redisUrl,
    proverThreads: proverThreads ? parseInt(proverThreads, 10) : undefined,
    noirExecuteBinaryPath: optionalEnv('OXIDE_RESOLVER_NOIR_EXECUTE_BINARY_PATH'),
    operatorId: optionalEnv('OXIDE_RESOLVER_OPERATOR_ID'),
  };
}
